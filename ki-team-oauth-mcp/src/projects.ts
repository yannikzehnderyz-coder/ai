import { DurableObject } from "cloudflare:workers";

/**
 * Projektgedächtnis (SQLite-Durable-Object, im Workers-Free-Tarif enthalten).
 *
 * - Ein Objekt pro angemeldetem GitHub-Konto (idFromName("user:<githubId>")) – Zugriff
 *   nur über die MCP-Werkzeuge nach erfolgreicher OAuth-Anmeldung.
 * - Strikte Projekttrennung: jede Abfrage ist an genau einen Projekt-Schlüssel gebunden.
 * - Es wird nichts gelöscht. Projekte lassen sich nur archivieren.
 * - Geheimnisse werden vor dem Speichern im MCP-Server abgewiesen (siehe sensitive.ts).
 */

export const MAX_PROJECTS = 50;
export const MAX_ENTRIES_PER_PROJECT = 500;
export const MAX_ENTRY_CHARS = 2000;
export const MAX_GOAL_CHARS = 2000;

export type EntryKind = "entscheidung" | "stand" | "notiz" | "ergebnis";

export interface Project {
	slug: string;
	name: string;
	goal: string;
	status: string;
	archived: boolean;
	created_at: string;
	updated_at: string;
	entries?: number;
}

export interface Entry {
	id: number;
	kind: EntryKind;
	text: string;
	created_at: string;
}

export function normalizeSlug(input: string): string | undefined {
	const s = input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ß/g, "ss")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s.length >= 2 ? s : undefined;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export class ProjectStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = this.ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)",
		);
		sql.exec("CREATE INDEX IF NOT EXISTS entries_slug ON entries (slug, id)");
	}

	private row(slug: string): Project | undefined {
		const r = this.ctx.storage.sql
			.exec<Record<string, string | number>>(
				"SELECT p.*, (SELECT COUNT(*) FROM entries e WHERE e.slug = p.slug) AS entries FROM projects p WHERE p.slug = ?",
				slug,
			)
			.toArray()[0];
		return r ? toProject(r) : undefined;
	}

	async list(includeArchived: boolean): Promise<Project[]> {
		return this.ctx.storage.sql
			.exec<Record<string, string | number>>(
				`SELECT p.*, (SELECT COUNT(*) FROM entries e WHERE e.slug = p.slug) AS entries FROM projects p ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY updated_at DESC`,
			)
			.toArray()
			.map(toProject);
	}

	async get(slug: string, maxEntries: number): Promise<Result<{ project: Project; entries: Entry[] }>> {
		const project = this.row(slug);
		if (!project) return { ok: false, error: `Projekt '${slug}' existiert nicht.` };
		const entries = this.ctx.storage.sql
			.exec<Record<string, string | number>>(
				"SELECT id, kind, text, created_at FROM entries WHERE slug = ? ORDER BY id DESC LIMIT ?",
				slug,
				Math.max(1, Math.min(200, maxEntries)),
			)
			.toArray()
			.map((r) => ({ id: Number(r.id), kind: r.kind as EntryKind, text: String(r.text), created_at: String(r.created_at) }))
			.reverse();
		return { ok: true, value: { project, entries } };
	}

	async upsert(
		slug: string,
		patch: { name?: string; goal?: string; status?: string; archived?: boolean },
	): Promise<Result<{ project: Project; created: boolean }>> {
		const now = new Date().toISOString();
		const existing = this.row(slug);
		if (!existing) {
			const count = Number(this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM projects").toArray()[0].c);
			if (count >= MAX_PROJECTS) return { ok: false, error: `Maximal ${MAX_PROJECTS} Projekte. Bitte ein bestehendes Projekt weiterverwenden oder archivieren.` };
			this.ctx.storage.sql.exec(
				"INSERT INTO projects (slug, name, goal, status, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				slug,
				(patch.name || slug).slice(0, 80),
				(patch.goal ?? "").slice(0, MAX_GOAL_CHARS),
				(patch.status ?? "").slice(0, 200),
				patch.archived ? 1 : 0,
				now,
				now,
			);
			return { ok: true, value: { project: this.row(slug)!, created: true } };
		}
		this.ctx.storage.sql.exec(
			"UPDATE projects SET name = ?, goal = ?, status = ?, archived = ?, updated_at = ? WHERE slug = ?",
			(patch.name ?? existing.name).slice(0, 80),
			(patch.goal ?? existing.goal).slice(0, MAX_GOAL_CHARS),
			(patch.status ?? existing.status).slice(0, 200),
			patch.archived === undefined ? (existing.archived ? 1 : 0) : patch.archived ? 1 : 0,
			now,
			slug,
		);
		return { ok: true, value: { project: this.row(slug)!, created: false } };
	}

	async addEntry(slug: string, kind: EntryKind, text: string): Promise<Result<{ id: number; total: number }>> {
		const project = this.row(slug);
		if (!project) return { ok: false, error: `Projekt '${slug}' existiert nicht.` };
		if ((project.entries ?? 0) >= MAX_ENTRIES_PER_PROJECT) {
			return { ok: false, error: `Projekt '${slug}' hat das Maximum von ${MAX_ENTRIES_PER_PROJECT} Einträgen erreicht (es wird nichts automatisch gelöscht).` };
		}
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO entries (slug, kind, text, created_at) VALUES (?, ?, ?, ?)",
			slug,
			kind,
			text.slice(0, MAX_ENTRY_CHARS),
			now,
		);
		this.ctx.storage.sql.exec("UPDATE projects SET updated_at = ? WHERE slug = ?", now, slug);
		const id = Number(this.ctx.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").toArray()[0].id);
		return { ok: true, value: { id, total: (project.entries ?? 0) + 1 } };
	}

	/** Kompakter Projektkontext für Prompts (Ziel, Status, letzte Entscheidungen und Stände). */
	async context(slug: string, maxChars: number): Promise<Result<string>> {
		const project = this.row(slug);
		if (!project) return { ok: false, error: `Projekt '${slug}' existiert nicht.` };
		const pick = (kind: EntryKind, n: number) =>
			this.ctx.storage.sql
				.exec<{ text: string }>("SELECT text FROM entries WHERE slug = ? AND kind = ? ORDER BY id DESC LIMIT ?", slug, kind, n)
				.toArray()
				.map((r) => String(r.text))
				.reverse();
		const parts = [
			`Projekt: ${project.name}`,
			project.goal ? `Ziel: ${project.goal}` : "",
			project.status ? `Status: ${project.status}` : "",
			listBlock("Getroffene Entscheidungen (verbindlich)", pick("entscheidung", 10)),
			listBlock("Letzte Arbeitsstände", pick("stand", 5)),
		].filter(Boolean);
		let text = parts.join("\n");
		if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[… Projektkontext gekürzt]`;
		return { ok: true, value: text };
	}
}

function listBlock(title: string, items: string[]): string {
	return items.length ? `${title}:\n${items.map((t) => `- ${t.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}` : "";
}

function toProject(r: Record<string, string | number>): Project {
	return {
		slug: String(r.slug),
		name: String(r.name),
		goal: String(r.goal ?? ""),
		status: String(r.status ?? ""),
		archived: Number(r.archived) === 1,
		created_at: String(r.created_at),
		updated_at: String(r.updated_at),
		entries: r.entries === undefined ? undefined : Number(r.entries),
	};
}

export function projectStub(env: Env, githubId: number) {
	return env.PROJECT_STORE.get(env.PROJECT_STORE.idFromName(`user:${githubId}`));
}
