import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthHandler, csvSet, isAllowedRedirect, type Props } from "./auth";
import {
	BackendError,
	KiTeamBackend,
	MODEL_PROFILES,
	resolveRole,
	type ModelProfile,
	type Role,
	type RunResult,
} from "./backend";
import { intVar, limiterStub, type ReserveResult } from "./limiter";
import { normalizeSlug, projectStub, type EntryKind } from "./projects";
import { assessQuality, detectContradictions, formatQuality, type QualityReport } from "./quality";
import { fetchGithubSource, formatStatic, isTestFile, ReviewSourceError, staticReview } from "./review";
import { checkSensitive } from "./sensitive";

export { UsageLimiter } from "./limiter";
export { ProjectStore } from "./projects";

const VERSION = "3.1.0";
const MAX_TASK_CHARS = 8000;
const MAX_CONTEXT_CHARS = 12000;
const MAX_COLLAB_ROLES = 4;
const MAX_PIPELINE_STEPS = 5;
const MAX_REVIEW_ROLES = 3;
const MAX_CODE_CHARS = 30000;
const PROJECT_CONTEXT_CHARS = 3000;
const HANDOVER_CHARS = 6000;
const ROLE_CACHE_MS = 10 * 60_000;
// Fehlgeschlagene KI-Aufrufe (kein Modell hat geantwortet) werden dem MCP-Kontingent zurückgegeben –
// höchstens so oft pro Tag. Der Hauptworker zählt jeden Versuch trotzdem (harte Obergrenze).
const FAIL_REFUND_CAP = 5;
const REFUNDABLE_CODES = new Set([
	"model_unavailable",
	"empty_answer",
	"no_free_model",
	"models_unavailable",
	"openrouter_unreachable",
	"openrouter_rate_limit",
	"openrouter_daily_limit",
	"daily_limit",
	"timeout",
	"unreachable",
]);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type VerifyMode = "auto" | "always" | "never";

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function clip(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n[… gekürzt]`;
}

function describeLimit(r: Pick<ReserveResult, "remainingToday" | "dailyLimit" | "resetsAt">): string {
	return `Verbleibende KI-Aufrufe heute (MCP): ${r.remainingToday}/${r.dailyLimit} – Reset ${r.resetsAt} (UTC).`;
}

function errorText(e: unknown): string {
	if (e instanceof BackendError) return `Fehler vom KI-Team (${e.code}): ${e.message}`;
	if (e instanceof ReviewSourceError) return `Quelle nicht abrufbar: ${e.message}`;
	return "Unerwarteter Fehler im MCP-Server.";
}

function formatRun(r: RunResult, fallbackName: string, title?: string): string {
	const name = title || r.roleName || fallbackName;
	const meta = [r.model ? `Modell: ${r.model}` : "", r.profile ? `Profil: ${r.profile}` : "", r.cached ? "aus Cache (0 KI-Aufrufe)" : ""]
		.filter(Boolean)
		.join(" · ");
	return `### ${name}${meta ? ` · ${meta}` : ""}\n\n${r.output.trim()}`;
}

async function sha256(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gemeinsame optionale Parameter (abwärtskompatibel: alle optional)
const projectParam = z.string().min(2).max(60).optional().describe("Projekt-Schlüssel: Ziel, Entscheidungen und Stand dieses Projekts werden als Kontext mitgegeben; das Ergebnis wird als Arbeitsstand protokolliert");
const profileParam = z.enum(MODEL_PROFILES as [ModelProfile, ...ModelProfile[]]).optional().describe("Modell-Routing: auto (Standard, nach Rolle), code, reasoning, writing, fast, long – immer nur kostenlose ':free'-Modelle");
const verifyParam = z.enum(["auto", "always", "never"]).optional().describe("Nachprüfung durch 'Kritische Prüfung': auto (Standard) nur bei gravierenden Auffälligkeiten und genügend Restkontingent (+1 KI-Aufruf), always, never");
const personalParam = z.boolean().optional().describe("Nur nach ausdrücklicher Zustimmung des Nutzers auf true setzen: erlaubt personenbezogene Daten (E-Mail, Telefon, IBAN …) an externe Modelle zu geben. Zugangsdaten werden nie weitergegeben.");
const estimateParam = z.boolean().optional().describe("Nur Kontingentbedarf berechnen, nichts ausführen (0 KI-Aufrufe)");

interface Budget {
	reserved: number;
	used: number;
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "Mein KI-Team", version: VERSION });

	private roleCache?: { at: number; roles: Role[] };

	private get backend() {
		return new KiTeamBackend(this.env);
	}

	private get limiter() {
		return limiterStub(this.env);
	}

	/** Zusätzliche Absicherung: Token muss zum erlaubten GitHub-Account gehören. */
	private authorized(): boolean {
		const id = this.props?.githubId;
		return typeof id === "number" && csvSet(this.env.ALLOWED_GITHUB_USER_IDS).has(String(id));
	}

	private async roles(force = false): Promise<Role[]> {
		if (!force && this.roleCache && Date.now() - this.roleCache.at < ROLE_CACHE_MS) return this.roleCache.roles;
		const roles = await this.backend.roles();
		this.roleCache = { at: Date.now(), roles };
		return roles;
	}

	private limits() {
		return {
			daily: intVar(this.env.MCP_DAILY_LIMIT, 20, 1, 1000),
			perMinute: intVar(this.env.MCP_PER_MINUTE_LIMIT, 6, 0, 100),
			qualityReserve: intVar(this.env.QUALITY_RESERVE, 4, 0, 100),
			cacheTtlMs: intVar(this.env.CACHE_TTL_MINUTES, 360, 0, 7 * 24 * 60) * 60_000,
		};
	}

	private async status() {
		return this.limiter.status("ai", this.limits().daily);
	}

	private async footer(extra?: string): Promise<string> {
		return `---\n${extra ? `${extra}\n` : ""}${describeLimit(await this.status())}`;
	}

	/** Reserviert atomar `units` KI-Aufrufe – alles oder nichts. */
	private async reserve(units: number): Promise<{ result: ReserveResult; denied?: ToolResult }> {
		const { daily, perMinute } = this.limits();
		const result = await this.limiter.reserve("ai", units, daily, perMinute);
		if (!result.ok) {
			const msg =
				result.reason === "minute"
					? `Zu viele Anfragen in kurzer Zeit (max. ${perMinute} pro Minute). Bitte kurz warten.`
					: `Tageslimit erreicht: Diese Aktion bräuchte ${units} KI-Aufruf(e), heute sind noch ${result.remainingToday} von ${result.dailyLimit} frei. Reset ${result.resetsAt} (UTC).`;
			return { result, denied: err(msg) };
		}
		return { result };
	}

	private async release(units: number) {
		if (units > 0) await this.limiter.release("ai", units);
	}

	private coordinator(roles: Role[]): Role | undefined {
		return resolveRole(roles, this.env.COORDINATOR_ROLE || "KI-Koordination");
	}

	private async safe(fn: () => Promise<ToolResult>): Promise<ToolResult> {
		if (!this.authorized()) return err("Nicht autorisiert.");
		try {
			return await fn();
		} catch (e) {
			console.error("Tool-Fehler", e instanceof Error ? e.message : String(e));
			return err(errorText(e));
		}
	}

	private gate(texts: (string | undefined)[], allowPersonal?: boolean): ToolResult | undefined {
		const d = checkSensitive(texts, !!allowPersonal, "an externe KI-Modelle");
		return d.ok ? undefined : err(d.message!);
	}

	private async resolveRoles(names: string[]): Promise<{ roles?: Role[]; error?: ToolResult }> {
		const all = await this.roles();
		const out: Role[] = [];
		for (const n of names) {
			const r = resolveRole(all, n);
			if (!r) return { error: err(`Rolle '${n}' nicht gefunden. Verfügbar: ${all.map((x) => x.name).join(", ")}`) };
			if (!out.some((x) => x.id === r.id)) out.push(r);
		}
		return { roles: out };
	}

	// ---------- Projektgedächtnis ----------

	private projects() {
		return projectStub(this.env, this.props!.githubId);
	}

	private async projectContext(project?: string): Promise<{ slug?: string; text?: string; error?: ToolResult }> {
		if (!project) return {};
		const slug = normalizeSlug(project);
		if (!slug) return { error: err("Ungültiger Projekt-Schlüssel.") };
		const r = await this.projects().context(slug, PROJECT_CONTEXT_CHARS);
		if (!r.ok) return { error: err(`${r.error} Mit ki_team_project_save anlegen.`) };
		return { slug, text: r.value };
	}

	private async logResult(slug: string | undefined, label: string, task: string, res: RunResult, q?: QualityReport): Promise<string> {
		if (!slug) return "";
		const text = `${label}: „${task.replace(/\s+/g, " ").slice(0, 150)}“ → ${res.output.replace(/\s+/g, " ").slice(0, 400)}${q ? ` [Qualität ${q.score}/100]` : ""}`;
		const r = await this.projects().addEntry(slug, "ergebnis", text);
		return r.ok ? `Arbeitsstand im Projekt '${slug}' protokolliert.` : `Hinweis: ${r.error}`;
	}

	private withProject(projectText: string | undefined, context: string | undefined): string | undefined {
		const parts = [projectText ? `Projektkontext (verbindliche Vorgaben):\n${projectText}` : "", context ?? ""].filter(Boolean);
		return parts.length ? clip(parts.join("\n\n---\n"), MAX_CONTEXT_CHARS) : undefined;
	}

	// ---------- Ausführung mit Cache ----------

	private async cacheKey(role: Role, task: string, context: string | undefined, profile?: ModelProfile) {
		return `run:${await sha256(JSON.stringify([role.id, task, context ?? "", profile ?? "auto"]))}`;
	}

	private async fromCache(key: string): Promise<RunResult | undefined> {
		if (!this.limits().cacheTtlMs) return undefined;
		const hit = await this.limiter.cacheGet(key);
		if (!hit) return undefined;
		try {
			return { ...(JSON.parse(hit) as RunResult), cached: true };
		} catch {
			return undefined;
		}
	}

	/** Führt einen Schritt aus: Cache-Treffer kosten nichts, sonst wird 1 reservierte Einheit verbraucht. */
	private async step(role: Role, task: string, context: string | undefined, profile: ModelProfile | undefined, budget: Budget, fresh = false): Promise<RunResult> {
		const key = await this.cacheKey(role, task, context, profile);
		if (!fresh) {
			const hit = await this.fromCache(key);
			if (hit) return hit;
		}
		if (budget.used >= budget.reserved) throw new BackendError("Internes Budget überschritten.", 500, "budget");
		budget.used++;
		let res: RunResult;
		try {
			res = await this.backend.run(role.id, task, context, profile);
		} catch (e) {
			// Kein Modell hat geantwortet: Einheit zurückgeben (gedeckelt), damit Fehlschläge das Kontingent nicht aufbrauchen
			if (e instanceof BackendError && REFUNDABLE_CODES.has(e.code) && (await this.refundAllowed())) budget.used--;
			throw e;
		}
		const ttl = this.limits().cacheTtlMs;
		if (ttl) await this.limiter.cachePut(key, JSON.stringify({ ...res, cached: undefined }), ttl);
		return res;
	}

	/** Prüft und verbucht, ob heute noch eine Rückerstattung für einen Fehlschlag erlaubt ist. */
	private async refundAllowed(): Promise<boolean> {
		const r = await this.limiter.reserve("fail_refund", 1, FAIL_REFUND_CAP, 0);
		return r.ok;
	}

	/** Gezielte Nachprüfung (nur bei Bedarf) – kostet 1 KI-Aufruf. */
	private async verify(task: string, output: string, report: QualityReport, mode: VerifyMode): Promise<string> {
		if (mode === "never") return "";
		if (mode === "auto" && !report.severe) return "";
		const { qualityReserve } = this.limits();
		const s = await this.status();
		if (mode === "auto" && s.remainingToday < qualityReserve + 1) {
			return `Nachprüfung übersprungen: Restkontingent (${s.remainingToday}) unter der Reserve von ${qualityReserve} Aufrufen.`;
		}
		const roles = await this.roles();
		const checker = resolveRole(roles, this.env.VERIFY_ROLE || "Kritische Prüfung");
		if (!checker) return "Nachprüfung nicht möglich: Prüfrolle nicht gefunden.";
		const { denied } = await this.reserve(1);
		if (denied) return `Nachprüfung nicht möglich: ${denied.content[0].text}`;
		await this.limiter.reserve("verify", 1, 100_000, 0);
		try {
			const res = await this.backend.run(
				checker.id,
				`Prüfe die folgende Antwort auf die Aufgabe kritisch auf sachliche Fehler, Lücken und Widersprüche. Antworte knapp mit einer nummerierten Liste konkreter Probleme und Korrekturen – oder mit „Keine wesentlichen Probleme“.\n\nAufgabe:\n${clip(task, 3000)}${report.issues.length ? `\n\nAutomatisch erkannte Hinweise: ${report.issues.map((i) => i.text).join(" ")}` : ""}`,
				clip(`Zu prüfende Antwort:\n${output}`, MAX_CONTEXT_CHARS),
				"reasoning",
			);
			return formatRun(res, checker.name, `Nachprüfung (${checker.name})`);
		} catch (e) {
			await this.release(1);
			return `Nachprüfung fehlgeschlagen: ${errorText(e)}`;
		}
	}

	async init() {
		// 1) Status – kein KI-Aufruf
		this.server.tool(
			"ki_team_status",
			"Prüft, ob das private KI-Team (Hauptworker) erreichbar ist, und zeigt verfügbare kostenlose Modelle/Routing. Verursacht keinen KI-Aufruf.",
			{},
			async () =>
				this.safe(async () => {
					const h = await this.backend.health();
					let models = "Modell-Routing: vom Hauptworker nicht gemeldet (Hauptworker < v3).";
					try {
						const m = await this.backend.models();
						const prof = Object.entries(m.profiles ?? {})
							.map(([k, v]) => `${k} ${v.length}`)
							.join(", ");
						const lines = [`Kostenlose Modelle: ${m.free}${prof ? ` · Routing-Profile: ${prof}` : ""}`];
						if (m.limits) lines.push(`Fallback: bis zu ${m.limits.modelsPerRequest} Modelle je Anfrage, höchstens ${m.limits.maxRequests} Anfragen je Auftrag (nur Preis 0).`);
						if (m.blockedUntil) lines.push(`⚠️ OpenRouter-Tageslimit erreicht – keine Anfragen bis ${m.blockedUntil} (UTC).`);
						if (m.reliable?.length) lines.push(`Zuletzt zuverlässig: ${m.reliable.join(", ")}`);
						if (m.cooling?.length) lines.push(`Pausiert (mehrere Fehlschläge): ${m.cooling.join(", ")}`);
						if (m.recent?.length) {
							const kinds = new Map<string, number>();
							for (const r of m.recent) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
							const last = m.recent[m.recent.length - 1];
							lines.push(
								`Letzte Fehlschläge: ${[...kinds].map(([k, n]) => `${k} ${n}×`).join(", ")} · zuletzt ${last.t.slice(0, 16).replace("T", " ")} UTC: ${last.kind}${last.status ? ` (HTTP ${last.status})` : ""}${last.models?.length ? ` – ${last.models.join(", ")}` : ""}`,
							);
						}
						models = lines.join("\n");
					} catch {
						/* ältere Hauptworker-Version */
					}
					return ok(
						`KI-Team erreichbar: ${h.ok ? "ja" : "nein"}${h.roles ? ` · ${h.roles} Rollen` : ""}${h.version ? ` · Version ${h.version}` : ""} · MCP-Server ${VERSION}\n${models}\n${describeLimit(await this.status())}`,
					);
				}),
		);

		// 2) Rollenliste – kein KI-Aufruf, kommt dynamisch aus dem Hauptworker
		this.server.tool(
			"ki_team_list_roles",
			"Listet alle KI-Rollen des Teams mit ID, Name und Beschreibung auf (live aus dem Hauptworker). Verursacht keinen KI-Aufruf. Nutze dies, um passende Rollen auszuwählen.",
			{},
			async () =>
				this.safe(async () => {
					const roles = await this.roles(true);
					const lines = roles.map((r) => `- ${r.name} (id: ${r.id})${r.description ? ` – ${r.description}` : ""}`);
					return ok(`${roles.length} Rollen im KI-Team:\n${lines.join("\n")}`);
				}),
		);

		// 3) Aufgabe an eine Rolle – 1 KI-Aufruf (0 bei Cache-Treffer)
		this.server.tool(
			"ki_team_run_role",
			"Übergibt eine Aufgabe an eine bestimmte Rolle des KI-Teams (z. B. 'Marketing', 'Sicherheit', 'Programmierung'). Kostet 1 KI-Aufruf (0 bei identischer Anfrage aus dem Cache). Antwort wird automatisch ohne KI-Aufruf auf Qualität geprüft.",
			{
				role: z.string().min(1).max(100).describe("Rollen-ID oder Rollenname, z. B. 'Marketing'"),
				task: z.string().min(1).max(MAX_TASK_CHARS).describe("Die Aufgabe für die Rolle"),
				context: z.string().max(MAX_CONTEXT_CHARS).optional().describe("Optionaler Zusatzkontext"),
				project: projectParam,
				profile: profileParam,
				verify: verifyParam,
				fresh: z.boolean().optional().describe("Cache umgehen und neu berechnen"),
				allow_personal_data: personalParam,
			},
			async ({ role, task, context, project, profile, verify, fresh, allow_personal_data }) =>
				this.safe(async () => {
					const { roles, error } = await this.resolveRoles([role]);
					if (error) return error;
					const r = roles![0];
					const p = await this.projectContext(project);
					if (p.error) return p.error;
					const ctx = this.withProject(p.text, context);
					const blocked = this.gate([task, ctx], allow_personal_data);
					if (blocked) return blocked;

					const key = await this.cacheKey(r, task, ctx, profile);
					let res = fresh ? undefined : await this.fromCache(key);
					if (!res) {
						const { denied } = await this.reserve(1);
						if (denied) return denied;
						const budget: Budget = { reserved: 1, used: 0 };
						try {
							res = await this.step(r, task, ctx, profile, budget, true);
						} finally {
							await this.release(budget.reserved - budget.used);
						}
					}
					const q = assessQuality(task, res.output, res.finishReason);
					const check = await this.verify(task, res.output, q, verify ?? "auto");
					const log = await this.logResult(p.slug, r.name, task, res, q);
					return ok([formatRun(res, r.name), formatQuality(q), check, await this.footer(log)].filter(Boolean).join("\n\n"));
				}),
		);

		// 4) Automatische Delegation – Koordinator wählt, dann Ausführung
		this.server.tool(
			"ki_team_auto_delegate",
			"Lässt die Rolle 'KI-Koordination' die passende(n) Rolle(n) für eine Aufgabe auswählen. Mit execute=true (Standard) wird die Aufgabe danach von der besten Rolle bearbeitet. Kosten: 1 KI-Aufruf für die Auswahl, +1 für die Ausführung. Tipp: Wenn die passende Rolle offensichtlich ist, lieber direkt ki_team_run_role nutzen (spart 1 Aufruf).",
			{
				task: z.string().min(1).max(MAX_TASK_CHARS),
				execute: z.boolean().default(true).describe("Aufgabe direkt von der gewählten Rolle bearbeiten lassen"),
				max_suggestions: z.number().int().min(1).max(5).default(3).describe("Wie viele Rollen vorgeschlagen werden"),
				project: projectParam,
				allow_personal_data: personalParam,
			},
			async ({ task, execute, max_suggestions, project, allow_personal_data }) =>
				this.safe(async () => {
					const roles = await this.roles();
					const coord = this.coordinator(roles);
					if (!coord) return err(`Koordinator-Rolle '${this.env.COORDINATOR_ROLE}' nicht gefunden.`);
					const candidates = roles.filter((r) => r.id !== coord.id);
					const p = await this.projectContext(project);
					if (p.error) return p.error;
					const ctx = this.withProject(p.text, undefined);
					const blocked = this.gate([task, ctx], allow_personal_data);
					if (blocked) return blocked;

					const budget: Budget = { reserved: execute ? 2 : 1, used: 0 };
					const { denied } = await this.reserve(budget.reserved);
					if (denied) return denied;
					try {
						const roster = candidates.map((r) => `${r.id} | ${r.name}${r.description ? ` | ${r.description}` : ""}`).join("\n");
						const routingTask = [
							`Wähle die ${max_suggestions} am besten geeigneten Rollen für die unten stehende Aufgabe, beste zuerst.`,
							`Antworte AUSSCHLIESSLICH mit JSON im Format {"roles":["<id>", ...],"reason":"<ein Satz>"} – ohne weiteren Text.`,
							`Erlaubte Rollen (id | name | beschreibung):\n${roster}`,
							`Aufgabe:\n${task}`,
						].join("\n\n");
						const routing = await this.step(coord, routingTask, undefined, undefined, budget);
						const pick = parseRolePick(routing.output, candidates);
						const picked = { roles: pick.roles.slice(0, max_suggestions), reason: pick.reason };
						if (!picked.roles.length) {
							await this.release(budget.reserved - budget.used);
							return err(`Der Koordinator konnte keine Rolle zuordnen. Antwort war:\n${clip(routing.output, 1500)}`);
						}
						const header = `Vorgeschlagene Rollen: ${picked.roles.map((r) => r.name).join(", ")}${picked.reason ? `\nBegründung: ${picked.reason}` : ""}`;
						if (!execute) {
							await this.release(budget.reserved - budget.used);
							return ok(`${header}\n\n${await this.footer()}`);
						}
						const res = await this.step(picked.roles[0], task, ctx, undefined, budget);
						await this.release(budget.reserved - budget.used);
						const q = assessQuality(task, res.output, res.finishReason);
						const log = await this.logResult(p.slug, picked.roles[0].name, task, res, q);
						return ok([header, formatRun(res, picked.roles[0].name), formatQuality(q), await this.footer(log)].join("\n\n"));
					} catch (e) {
						await this.release(budget.reserved - budget.used);
						throw e;
					}
				}),
		);

		// 5) Zusammenarbeit mehrerer Rollen
		this.server.tool(
			"ki_team_collaborate",
			`Lässt 2–${MAX_COLLAB_ROLES} Rollen gemeinsam an einer Aufgabe arbeiten. mode='parallel' (Standard, schneller): alle Rollen arbeiten unabhängig. mode='sequential': jede Rolle baut auf den vorherigen Beiträgen auf. Optional fasst 'KI-Koordination' alles zusammen. Kosten: 1 KI-Aufruf pro Rolle (+1 für die Zusammenfassung); das Budget wird vorab komplett reserviert, Ungenutztes (z. B. Cache-Treffer) wird zurückgegeben. Jeder Beitrag wird automatisch geprüft, mögliche Widersprüche werden markiert.`,
			{
				task: z.string().min(1).max(MAX_TASK_CHARS),
				roles: z.array(z.string().min(1).max(100)).min(2).max(MAX_COLLAB_ROLES).describe("Rollen-IDs oder -Namen"),
				mode: z.enum(["parallel", "sequential"]).default("parallel"),
				synthesize: z.boolean().default(true).describe("Ergebnisse durch 'KI-Koordination' zusammenfassen lassen"),
				project: projectParam,
				profile: profileParam,
				verify: verifyParam,
				estimate_only: estimateParam,
				allow_personal_data: personalParam,
			},
			async ({ task, roles: wanted, mode, synthesize, project, profile, verify, estimate_only, allow_personal_data }) =>
				this.safe(async () => {
					const { roles: chosen, error } = await this.resolveRoles(wanted);
					if (error) return error;
					if (chosen!.length < 2) return err("Bitte mindestens zwei verschiedene Rollen angeben.");
					const coord = synthesize ? this.coordinator(await this.roles()) : undefined;
					if (synthesize && !coord) return err(`Koordinator-Rolle '${this.env.COORDINATOR_ROLE}' nicht gefunden.`);
					const units = chosen!.length + (coord ? 1 : 0);
					if (estimate_only) return ok(await this.estimate(units, verify ?? "auto"));

					const p = await this.projectContext(project);
					if (p.error) return p.error;
					const baseCtx = this.withProject(p.text, undefined);
					const blocked = this.gate([task, baseCtx], allow_personal_data);
					if (blocked) return blocked;

					const budget: Budget = { reserved: units, used: 0 };
					const { denied } = await this.reserve(units);
					if (denied) return denied;

					const results: { role: Role; res?: RunResult; error?: string; q?: QualityReport }[] = [];
					try {
						if (mode === "parallel") {
							const settled = await Promise.allSettled(chosen!.map((r) => this.step(r, task, baseCtx, profile, budget)));
							settled.forEach((s, i) =>
								results.push(s.status === "fulfilled" ? { role: chosen![i], res: s.value } : { role: chosen![i], error: errorText(s.reason) }),
							);
						} else {
							for (const r of chosen!) {
								const prior = results.filter((x) => x.res).map((x) => `Beitrag von ${x.role.name}:\n${x.res!.output}`).join("\n\n");
								const ctx = this.withProject(
									p.text,
									prior ? clip(`Bisherige Beiträge des Teams – baue darauf auf, ergänze und korrigiere:\n\n${prior}`, MAX_CONTEXT_CHARS) : undefined,
								);
								try {
									results.push({ role: r, res: await this.step(r, task, ctx, profile, budget) });
								} catch (e) {
									results.push({ role: r, error: errorText(e) });
								}
							}
						}
						for (const x of results) if (x.res) x.q = assessQuality(task, x.res.output, x.res.finishReason);

						const good = results.filter((x) => x.res);
						const contradictions = detectContradictions(good.map((x) => ({ name: x.role.name, text: x.res!.output })));
						let synthesis: RunResult | undefined;
						let synthesisNote = "";
						if (coord) {
							if (good.length >= 1) {
								try {
									synthesis = await this.step(
										coord,
										`Fasse die Beiträge des Teams zur folgenden Aufgabe zu einem klaren Gesamtergebnis zusammen. Benenne Übereinstimmungen, Widersprüche und konkrete nächste Schritte.${contradictions.length ? ` Achte besonders auf: ${contradictions.join(" ")}` : ""}\n\nAufgabe:\n${task}`,
										this.withProject(p.text, clip(good.map((x) => `Beitrag von ${x.role.name}:\n${x.res!.output}`).join("\n\n"), MAX_CONTEXT_CHARS)),
										profile,
										budget,
									);
								} catch (e) {
									synthesisNote = `Zusammenfassung fehlgeschlagen: ${errorText(e)}`;
								}
							} else {
								synthesisNote = "Keine Zusammenfassung, da kein Beitrag erfolgreich war.";
							}
						}
						await this.release(budget.reserved - budget.used);

						const parts = results.map((x) =>
							x.res ? `${formatRun(x.res, x.role.name)}\n\n${formatQuality(x.q!)}` : `### ${x.role.name}\n\n⚠️ ${x.error}`,
						);
						if (contradictions.length) parts.push(`⚠️ ${contradictions.join(" ")}`);
						let finalOut = good.length ? good[good.length - 1].res!.output : "";
						if (synthesis) {
							const sq = assessQuality(task, synthesis.output, synthesis.finishReason);
							parts.push(`${formatRun(synthesis, coord!.name, `Zusammenfassung (${coord!.name})`)}\n\n${formatQuality(sq)}`);
							finalOut = synthesis.output;
							const check = await this.verify(task, finalOut, sq, verify ?? "auto");
							if (check) parts.push(check);
						}
						if (synthesisNote) parts.push(synthesisNote);
						const log = synthesis
							? await this.logResult(p.slug, `Team (${chosen!.map((c) => c.name).join(", ")})`, task, synthesis)
							: good.length
								? await this.logResult(p.slug, `Team (${chosen!.map((c) => c.name).join(", ")})`, task, good[good.length - 1].res!)
								: "";
						parts.push(await this.footer(log));
						return { content: [{ type: "text", text: parts.join("\n\n") }], isError: good.length === 0 };
					} catch (e) {
						await this.release(budget.reserved - budget.used);
						throw e;
					}
				}),
		);

		// 6) Nutzung – kein KI-Aufruf
		this.server.tool(
			"ki_team_usage",
			"Zeigt die heutige Nutzung und verbleibenden KI-Aufrufe (MCP-Limit, Cache-Ersparnis, Nachprüfungen und – falls verfügbar – das Limit des Hauptworkers). Verursacht keinen KI-Aufruf.",
			{},
			async () =>
				this.safe(async () => {
					const s = await this.status();
					const [hits, checks, refunds] = await Promise.all([
						this.limiter.counter("cache_hit"),
						this.limiter.counter("verify"),
						this.limiter.counter("fail_refund"),
					]);
					let backendLine = "Hauptworker-Limit: nicht abrufbar.";
					try {
						const u = await this.backend.usage();
						if (typeof u.used === "number" && typeof u.limit === "number") {
							backendLine = `Hauptworker-Limit: ${u.used}/${u.limit} genutzt${typeof u.remaining === "number" ? `, ${u.remaining} frei` : ""}${u.resetsAt ? ` – Reset ${u.resetsAt}` : ""}.`;
						}
					} catch (e) {
						backendLine = `Hauptworker-Limit: nicht abrufbar (${errorText(e)}).`;
					}
					const l = this.limits();
					return ok(
						[
							describeLimit(s),
							backendLine,
							`Pro Minute max. ${l.perMinute} KI-Aufrufe über MCP.`,
							`Heute aus dem Cache beantwortet (0 Aufrufe): ${hits} · Nachprüfungen: ${checks} · Reserve für Nachprüfungen: ${l.qualityReserve}.`,
							`Zurückerstattete Fehlschläge heute: ${refunds}/${FAIL_REFUND_CAP} (danach zählen Fehlschläge normal).`,
						].join("\n"),
					);
				}),
		);

		// 7) Mehrstufige Teamarbeit
		this.server.tool(
			"ki_team_pipeline",
			`Mehrstufige Teamarbeit: 2–${MAX_PIPELINE_STEPS} Rollen arbeiten NACHEINANDER an einer Aufgabe, z. B. Recherche → Programmierung → Codeprüfung. Jeder Schritt bekommt nur das geprüfte Ergebnis des vorherigen Schritts (kontrollierte Übergabe). Bei gravierenden Qualitätsproblemen wird angehalten (stop_on_issue). Kosten: 1 KI-Aufruf je Schritt, vorab reserviert; nicht genutzte Aufrufe werden zurückgegeben.`,
			{
				task: z.string().min(1).max(MAX_TASK_CHARS),
				steps: z
					.array(
						z.object({
							role: z.string().min(1).max(100),
							instruction: z.string().max(2000).optional().describe("Konkreter Arbeitsauftrag für diesen Schritt"),
						}),
					)
					.min(2)
					.max(MAX_PIPELINE_STEPS),
				stop_on_issue: z.boolean().optional().describe("Bei gravierenden Problemen anhalten (Standard: true)"),
				project: projectParam,
				profile: profileParam,
				verify: verifyParam,
				estimate_only: estimateParam,
				allow_personal_data: personalParam,
			},
			async ({ task, steps, stop_on_issue, project, profile, verify, estimate_only, allow_personal_data }) =>
				this.safe(async () => {
					const { roles: stepRoles, error } = await this.resolveRolesKeepOrder(steps.map((s) => s.role));
					if (error) return error;
					if (estimate_only) return ok(await this.estimate(steps.length, verify ?? "auto"));
					const p = await this.projectContext(project);
					if (p.error) return p.error;
					const blocked = this.gate([task, p.text, ...steps.map((s) => s.instruction)], allow_personal_data);
					if (blocked) return blocked;

					const budget: Budget = { reserved: steps.length, used: 0 };
					const { denied } = await this.reserve(steps.length);
					if (denied) return denied;
					const parts: string[] = [];
					let previous: { name: string; output: string } | undefined;
					let last: { res: RunResult; q: QualityReport; name: string } | undefined;
					let stoppedNote = "";
					try {
						for (let i = 0; i < steps.length; i++) {
							const role = stepRoles![i];
							const stepTask = `${task}${steps[i].instruction ? `\n\nDein Arbeitsschritt (${i + 1}/${steps.length}): ${steps[i].instruction}` : `\n\nDu bist Schritt ${i + 1} von ${steps.length} einer Teamkette.`}`;
							const handover = previous
								? `Geprüftes Ergebnis des vorherigen Schritts (${previous.name}) – darauf aufbauen, Fehler korrigieren:\n${clip(previous.output, HANDOVER_CHARS)}`
								: undefined;
							let res: RunResult;
							try {
								res = await this.step(role, stepTask, this.withProject(p.text, handover), profile, budget);
							} catch (e) {
								parts.push(`### Schritt ${i + 1}: ${role.name}\n\n⚠️ ${errorText(e)}`);
								stoppedNote = `Kette nach Schritt ${i + 1} wegen eines Fehlers angehalten.`;
								break;
							}
							const q = assessQuality(stepTask, res.output, res.finishReason);
							parts.push(`${formatRun(res, role.name, `Schritt ${i + 1}: ${role.name}`)}\n\n${formatQuality(q)}`);
							last = { res, q, name: role.name };
							if (q.severe && (stop_on_issue ?? true) && i < steps.length - 1) {
								stoppedNote = `Kette nach Schritt ${i + 1} angehalten: Das Ergebnis ist für die Weitergabe nicht verlässlich genug (${q.issues.map((x) => x.text).join(" ")}).`;
								break;
							}
							previous = { name: role.name, output: res.output };
						}
						await this.release(budget.reserved - budget.used);
						if (stoppedNote) parts.push(`⚠️ ${stoppedNote} Nicht genutzte Aufrufe wurden zurückgegeben.`);
						if (last && !stoppedNote) {
							const check = await this.verify(task, last.res.output, last.q, verify ?? "auto");
							if (check) parts.push(check);
						}
						const log = last ? await this.logResult(p.slug, `Kette (${stepRoles!.map((r) => r.name).join(" → ")})`, task, last.res, last.q) : "";
						parts.push(await this.footer(log));
						return { content: [{ type: "text", text: parts.join("\n\n") }], isError: !last };
					} catch (e) {
						await this.release(budget.reserved - budget.used);
						throw e;
					}
				}),
		);

		// 8) Qualitätsprüfung eines beliebigen Textes
		this.server.tool(
			"ki_team_quality_check",
			"Prüft einen Text (z. B. ein Ergebnis) auf Vollständigkeit, Fehler und Widersprüche. Standard: nur automatische Prüfung ohne KI-Aufruf. Mit deep=true zusätzlich gezielte Nachprüfung durch 'Kritische Prüfung' (1 KI-Aufruf).",
			{
				task: z.string().min(1).max(MAX_TASK_CHARS).describe("Ursprüngliche Aufgabe/Anforderung"),
				text: z.string().min(1).max(MAX_CONTEXT_CHARS).describe("Zu prüfendes Ergebnis"),
				deep: z.boolean().optional(),
				allow_personal_data: personalParam,
			},
			async ({ task, text, deep, allow_personal_data }) =>
				this.safe(async () => {
					const q = assessQuality(task, text);
					const out = [formatQuality(q)];
					if (q.issues.length) out.push(q.issues.map((i) => `- [${i.level}] ${i.text}`).join("\n"));
					if (deep) {
						const blocked = this.gate([task, text], allow_personal_data);
						if (blocked) return blocked;
						out.push(await this.verify(task, text, q, "always"));
					}
					out.push(await this.footer());
					return ok(out.filter(Boolean).join("\n\n"));
				}),
		);

		// 9–11) Projektgedächtnis
		this.server.tool(
			"ki_team_project_list",
			"Listet die gespeicherten Projekte im Projektgedächtnis (Ziel, Status, Anzahl Einträge). Kein KI-Aufruf.",
			{ include_archived: z.boolean().optional() },
			async ({ include_archived }) =>
				this.safe(async () => {
					const list = await this.projects().list(!!include_archived);
					if (!list.length) return ok("Noch keine Projekte gespeichert. Mit ki_team_project_save anlegen.");
					return ok(
						`${list.length} Projekt(e):\n${list
							.map((p) => `- ${p.name} (Schlüssel: ${p.slug})${p.archived ? " [archiviert]" : ""}${p.status ? ` – Status: ${p.status}` : ""} · ${p.entries ?? 0} Einträge · zuletzt ${p.updated_at.slice(0, 10)}`)
							.join("\n")}`,
					);
				}),
		);

		this.server.tool(
			"ki_team_project_get",
			"Zeigt Ziel, Status, Entscheidungen und Arbeitsstände eines Projekts. Kein KI-Aufruf.",
			{
				project: z.string().min(2).max(60),
				entries: z.number().int().min(1).max(100).optional().describe("Wie viele der letzten Einträge (Standard 20)"),
			},
			async ({ project, entries }) =>
				this.safe(async () => {
					const slug = normalizeSlug(project);
					if (!slug) return err("Ungültiger Projekt-Schlüssel.");
					const r = await this.projects().get(slug, entries ?? 20);
					if (!r.ok) return err(r.error);
					const { project: p, entries: e } = r.value;
					return ok(
						[
							`## ${p.name} (Schlüssel: ${p.slug})${p.archived ? " [archiviert]" : ""}`,
							`Ziel: ${p.goal || "–"}`,
							`Status: ${p.status || "–"}`,
							`Angelegt: ${p.created_at.slice(0, 10)} · Zuletzt: ${p.updated_at.slice(0, 10)} · Einträge gesamt: ${p.entries ?? 0}`,
							e.length ? `Letzte Einträge:\n${e.map((x) => `- ${x.created_at.slice(0, 16).replace("T", " ")} [${x.kind}] ${x.text}`).join("\n")}` : "Noch keine Einträge.",
						].join("\n"),
					);
				}),
		);

		this.server.tool(
			"ki_team_project_save",
			"Legt ein Projekt an oder aktualisiert es (Ziel, Status, Archivierung) und speichert Entscheidungen, Arbeitsstände oder Notizen dauerhaft. Es wird nichts gelöscht. Zugangsdaten werden abgewiesen. Kein KI-Aufruf.",
			{
				project: z.string().min(2).max(60).describe("Projekt-Schlüssel oder -Name"),
				name: z.string().max(80).optional(),
				goal: z.string().max(2000).optional(),
				status: z.string().max(200).optional(),
				archived: z.boolean().optional(),
				decision: z.string().max(2000).optional().describe("Getroffene Entscheidung (wird künftig als verbindlich mitgegeben)"),
				progress: z.string().max(2000).optional().describe("Aktueller Arbeitsstand"),
				note: z.string().max(2000).optional(),
				allow_personal_data: personalParam,
			},
			async ({ project, name, goal, status, archived, decision, progress, note, allow_personal_data }) =>
				this.safe(async () => {
					const slug = normalizeSlug(project);
					if (!slug) return err("Ungültiger Projekt-Schlüssel (mind. 2 Buchstaben/Ziffern).");
					const texts = [name, goal, status, decision, progress, note];
					const d = checkSensitive(texts, !!allow_personal_data, "im Projektgedächtnis gespeichert oder an Modelle weiter");
					if (!d.ok) return err(d.message!);
					const store = this.projects();
					const up = await store.upsert(slug, { name: name ?? (project !== slug ? project : undefined), goal, status, archived });
					if (!up.ok) return err(up.error);
					const saved: string[] = [up.value.created ? `Projekt '${slug}' angelegt.` : `Projekt '${slug}' aktualisiert.`];
					const add = async (kind: EntryKind, text?: string) => {
						if (!text?.trim()) return;
						const r = await store.addEntry(slug, kind, text.trim());
						saved.push(r.ok ? `${kind} gespeichert (#${r.value.id}).` : r.error);
					};
					await add("entscheidung", decision);
					await add("stand", progress);
					await add("notiz", note);
					return ok(saved.join("\n"));
				}),
		);

		// 12) Code- und Projektprüfung (nur lesend)
		this.server.tool(
			"ki_team_review_code",
			`Prüft Code, einen Pull Request oder eine Datei eines öffentlichen GitHub-Repositorys (nur freigegebene Besitzer) – NUR LESEND, es wird nie etwas geändert, gepusht oder veröffentlicht. Erst statische Sicherheits-/Qualitätsprüfung ohne KI-Aufruf, dann optional KI-Prüfung durch bis zu ${MAX_REVIEW_ROLES} Rollen (Standard: Codeprüfung, Sicherheit; je 1 KI-Aufruf, Modellprofil 'code').`,
			{
				code: z.string().max(MAX_CODE_CHARS).optional().describe("Eingefügter Code oder Diff"),
				repo: z.string().max(140).optional().describe("GitHub-Repository 'besitzer/name'"),
				pr: z.number().int().min(1).optional().describe("Pull-Request-Nummer"),
				path: z.string().max(300).optional().describe("Dateipfad im Repository"),
				ref: z.string().max(100).optional().describe("Branch/Tag/Commit für 'path'"),
				roles: z.array(z.string().min(1).max(100)).min(1).max(MAX_REVIEW_ROLES).optional(),
				ai_review: z.boolean().optional().describe("KI-Prüfung durchführen (Standard: true)"),
				project: projectParam,
				estimate_only: estimateParam,
				allow_personal_data: personalParam,
			},
			async ({ code, repo, pr, path, ref, roles, ai_review, project, estimate_only, allow_personal_data }) =>
				this.safe(async () => {
					const reviewerNames = roles?.length ? roles : ["Codeprüfung", "Sicherheit"];
					const { roles: reviewers, error } = await this.resolveRoles(reviewerNames);
					if (error) return error;
					const doAi = ai_review ?? true;
					if (estimate_only) return ok(await this.estimate(doAi ? reviewers!.length : 0, "never"));

					let source: { text: string; isDiff: boolean; label: string; files: string[]; truncated: boolean };
					if (code) {
						source = { text: code, isDiff: /^(diff --git|@@ |\+\+\+ |--- )/m.test(code), label: "eingefügter Code", files: [], truncated: false };
					} else if (repo) {
						source = await fetchGithubSource(this.env, { repo, pr, path, ref }, MAX_CODE_CHARS);
					} else {
						return err("Bitte 'code' einfügen oder 'repo' mit 'pr' bzw. 'path' angeben.");
					}

					const findings = staticReview(source.text, source.isDiff);
					const parts = [`## Prüfung: ${source.label}${source.truncated ? " (gekürzt)" : ""}`, formatStatic(findings)];
					if (source.files.length) {
						const tests = source.files.filter(isTestFile);
						parts.push(tests.length ? `Geänderte Testdateien: ${tests.join(", ")}` : "Hinweis: In dieser Änderung wurden keine Testdateien angepasst.");
					}

					const sens = checkSensitive([source.text], !!allow_personal_data, "an externe KI-Modelle");
					if (doAi && !sens.ok) {
						parts.push(`KI-Prüfung nicht durchgeführt: ${sens.message}`);
					} else if (doAi) {
						const p = await this.projectContext(project);
						if (p.error) return p.error;
						const budget: Budget = { reserved: reviewers!.length, used: 0 };
						const { denied } = await this.reserve(budget.reserved);
						if (denied) {
							parts.push(`KI-Prüfung nicht durchgeführt: ${denied.content[0].text}`);
						} else {
							const reviewTask =
								"Prüfe den folgenden Code bzw. Diff aus deiner Fachsicht. Liste konkrete Probleme mit Schweregrad (hoch/mittel/niedrig), Fundstelle und Korrekturvorschlag. Bestätige oder widerlege die Hinweise der statischen Prüfung. Schlage fehlende Tests vor. Keine Änderungen veröffentlichen – nur Empfehlungen.";
							const ctx = this.withProject(p.text, `${formatStatic(findings)}\n\nQuelle (${source.label}):\n${source.text}`);
							const settled = await Promise.allSettled(reviewers!.map((r) => this.step(r, reviewTask, ctx, "code", budget)));
							await this.release(budget.reserved - budget.used);
							settled.forEach((s, i) => {
								if (s.status === "fulfilled") {
									parts.push(`${formatRun(s.value, reviewers![i].name)}\n\n${formatQuality(assessQuality(reviewTask, s.value.output, s.value.finishReason))}`);
								} else {
									parts.push(`### ${reviewers![i].name}\n\n⚠️ ${errorText(s.reason)}`);
								}
							});
							const first = settled.find((s) => s.status === "fulfilled") as PromiseFulfilledResult<RunResult> | undefined;
							if (first) await this.logResult(p.slug, `Code-Prüfung ${source.label}`, reviewTask, first.value);
						}
					}
					parts.push("Nur lesend: Es wurde nichts geändert, gepusht oder veröffentlicht.");
					parts.push(await this.footer());
					return ok(parts.join("\n\n"));
				}),
		);
	}

	private async resolveRolesKeepOrder(names: string[]): Promise<{ roles?: Role[]; error?: ToolResult }> {
		const all = await this.roles();
		const out: Role[] = [];
		for (const n of names) {
			const r = resolveRole(all, n);
			if (!r) return { error: err(`Rolle '${n}' nicht gefunden. Verfügbar: ${all.map((x) => x.name).join(", ")}`) };
			out.push(r);
		}
		return { roles: out };
	}

	private async estimate(units: number, verify: VerifyMode): Promise<string> {
		const s = await this.status();
		const extra = verify === "never" ? 0 : 1;
		const enough = s.remainingToday >= units;
		return [
			`Kontingentbedarf: ${units} KI-Aufruf(e)${extra ? ` (+ höchstens 1 Nachprüfung, nur bei Bedarf)` : ""}. Cache-Treffer verringern den Bedarf.`,
			`Heute frei: ${s.remainingToday}/${s.dailyLimit}. ${enough ? "Ausführung möglich." : "Nicht genügend Kontingent."}`,
			"Es wurde nichts ausgeführt (0 KI-Aufrufe).",
		].join("\n");
	}
}

/** Liest die Rollenauswahl des Koordinators (JSON, sonst Namenssuche im Text). */
export function parseRolePick(text: string, candidates: Role[]): { roles: Role[]; reason?: string } {
	const unique = (rs: (Role | undefined)[]) => rs.filter((r, i, a): r is Role => !!r && a.findIndex((x) => x?.id === r.id) === i);
	const match = text.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const j = JSON.parse(match[0]) as { roles?: unknown; reason?: unknown };
			if (Array.isArray(j.roles)) {
				const roles = unique(j.roles.filter((x): x is string => typeof x === "string").map((x) => resolveRole(candidates, x)));
				if (roles.length) return { roles, reason: typeof j.reason === "string" ? j.reason : undefined };
			}
		} catch {
			/* Fallback unten */
		}
	}
	const lower = text.toLowerCase();
	const hits = candidates
		.map((r) => ({ r, i: Math.min(...[r.id, r.name].map((k) => lower.indexOf(k.toLowerCase())).filter((i) => i >= 0), Infinity) }))
		.filter((x) => x.i !== Infinity)
		.sort((a, b) => a.i - b.i)
		.map((x) => x.r);
	return { roles: unique(hits) };
}

// ---------- OAuth-Provider + Schutz der Client-Registrierung ----------

const provider = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: MyMCP.serve("/mcp"),
	defaultHandler: AuthHandler as any,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Dynamische Client-Registrierung nur für Claude-Redirects und gedrosselt
		// (verhindert, dass Fremde den KV-Speicher bzw. die KV-Free-Schreibgrenze ausreizen).
		if (url.pathname === "/register" && request.method === "POST") {
			let body: { redirect_uris?: unknown } = {};
			try {
				body = (await request.clone().json()) as typeof body;
			} catch {
				return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
			}
			const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
			if (!uris.length || !uris.every((u) => typeof u === "string" && isAllowedRedirect(env, u))) {
				return Response.json(
					{ error: "invalid_redirect_uri", error_description: "Redirect-URI ist nicht freigegeben." },
					{ status: 400 },
				);
			}
			const r = await limiterStub(env).reserve("register", 1, 30, 5);
			if (!r.ok) {
				return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "Retry-After": "60" } });
			}
		}

		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
