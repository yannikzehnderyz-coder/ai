import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthHandler, csvSet, isAllowedRedirect, type Props } from "./auth";
import { BackendError, KiTeamBackend, resolveRole, type Role, type RunResult } from "./backend";
import { intVar, limiterStub, type ReserveResult } from "./limiter";

export { UsageLimiter } from "./limiter";

const MAX_TASK_CHARS = 8000;
const MAX_CONTEXT_CHARS = 12000;
const MAX_COLLAB_ROLES = 4;
const ROLE_CACHE_MS = 10 * 60_000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

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
	return "Unerwarteter Fehler im MCP-Server.";
}

function formatRun(r: RunResult, fallbackName: string, title?: string): string {
	const name = title || r.roleName || fallbackName;
	const model = r.model ? ` · Modell: ${r.model}` : "";
	return `### ${name}${model}\n\n${r.output.trim()}`;
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "Mein KI-Team", version: "1.0.0" });

	private roleCache?: { at: number; roles: Role[] };

	private get backend() {
		return new KiTeamBackend(this.env);
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
		};
	}

	/** Reserviert atomar `units` KI-Aufrufe – alles oder nichts. */
	private async reserve(units: number): Promise<{ result: ReserveResult; denied?: ToolResult }> {
		const { daily, perMinute } = this.limits();
		const result = await limiterStub(this.env).reserve("ai", units, daily, perMinute);
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
		if (units > 0) await limiterStub(this.env).release("ai", units);
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

	async init() {
		// 1) Status – kein KI-Aufruf
		this.server.tool(
			"ki_team_status",
			"Prüft, ob das private KI-Team (Hauptworker) erreichbar ist. Verursacht keinen KI-Aufruf.",
			{},
			async () =>
				this.safe(async () => {
				const h = await this.backend.health();
				const s = await limiterStub(this.env).status("ai", this.limits().daily);
				return ok(
					`KI-Team erreichbar: ${h.ok ? "ja" : "nein"}${h.roles ? ` · ${h.roles} Rollen` : ""}${h.version ? ` · Version ${h.version}` : ""}\n${describeLimit(s)}`,
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

		// 3) Aufgabe an eine Rolle – 1 KI-Aufruf
		this.server.tool(
			"ki_team_run_role",
			"Übergibt eine Aufgabe an eine bestimmte Rolle des KI-Teams (z. B. 'Marketing', 'Sicherheit', 'Programmierung'). Kostet 1 KI-Aufruf vom Tageslimit.",
			{
				role: z.string().min(1).max(100).describe("Rollen-ID oder Rollenname, z. B. 'Marketing'"),
				task: z.string().min(1).max(MAX_TASK_CHARS).describe("Die Aufgabe für die Rolle"),
				context: z.string().max(MAX_CONTEXT_CHARS).optional().describe("Optionaler Zusatzkontext"),
			},
			async ({ role, task, context }) =>
				this.safe(async () => {
				const roles = await this.roles();
				const r = resolveRole(roles, role);
				if (!r) {
					return err(`Rolle '${role}' nicht gefunden. Verfügbar: ${roles.map((x) => x.name).join(", ")}`);
				}
				const { denied } = await this.reserve(1);
				if (denied) return denied;
				const res = await this.backend.run(r.id, task, context);
				const s = await limiterStub(this.env).status("ai", this.limits().daily);
				return ok(`${formatRun(res, r.name)}\n\n---\n${describeLimit(s)}`);
			}),
		);

		// 4) Automatische Delegation – Koordinator wählt, dann Ausführung
		this.server.tool(
			"ki_team_auto_delegate",
			"Lässt die Rolle 'KI-Koordination' die passende(n) Rolle(n) für eine Aufgabe auswählen. Mit execute=true (Standard) wird die Aufgabe danach von der besten Rolle bearbeitet. Kosten: 1 KI-Aufruf für die Auswahl, +1 für die Ausführung.",
			{
				task: z.string().min(1).max(MAX_TASK_CHARS),
				execute: z.boolean().default(true).describe("Aufgabe direkt von der gewählten Rolle bearbeiten lassen"),
				max_suggestions: z.number().int().min(1).max(5).default(3).describe("Wie viele Rollen vorgeschlagen werden"),
			},
			async ({ task, execute, max_suggestions }) =>
				this.safe(async () => {
				const roles = await this.roles();
				const coord = this.coordinator(roles);
				if (!coord) return err(`Koordinator-Rolle '${this.env.COORDINATOR_ROLE}' nicht gefunden.`);
				const candidates = roles.filter((r) => r.id !== coord.id);

				const units = execute ? 2 : 1;
				const { denied } = await this.reserve(units);
				if (denied) return denied;

				let used = 0;
				try {
					const roster = candidates
						.map((r) => `${r.id} | ${r.name}${r.description ? ` | ${r.description}` : ""}`)
						.join("\n");
					const routingTask = [
						`Wähle die ${max_suggestions} am besten geeigneten Rollen für die unten stehende Aufgabe, beste zuerst.`,
						`Antworte AUSSCHLIESSLICH mit JSON im Format {"roles":["<id>", ...],"reason":"<ein Satz>"} – ohne weiteren Text.`,
						`Erlaubte Rollen (id | name | beschreibung):\n${roster}`,
						`Aufgabe:\n${task}`,
					].join("\n\n");
					used++;
					const routing = await this.backend.run(coord.id, routingTask);
					const pick = parseRolePick(routing.output, candidates);
					const picked = { roles: pick.roles.slice(0, max_suggestions), reason: pick.reason };
					if (!picked.roles.length) {
						await this.release(units - used);
						return err(`Der Koordinator konnte keine Rolle zuordnen. Antwort war:\n${clip(routing.output, 1500)}`);
					}
					const header = `Vorgeschlagene Rollen: ${picked.roles.map((r) => r.name).join(", ")}${picked.reason ? `\nBegründung: ${picked.reason}` : ""}`;
					if (!execute) {
						const s = await limiterStub(this.env).status("ai", this.limits().daily);
						return ok(`${header}\n\n---\n${describeLimit(s)}`);
					}
					used++;
					const res = await this.backend.run(picked.roles[0].id, task);
					const s = await limiterStub(this.env).status("ai", this.limits().daily);
					return ok(`${header}\n\n${formatRun(res, picked.roles[0].name)}\n\n---\n${describeLimit(s)}`);
				} catch (e) {
					await this.release(units - used);
					throw e;
				}
			}),
		);

		// 5) Zusammenarbeit mehrerer Rollen
		this.server.tool(
			"ki_team_collaborate",
			`Lässt 2–${MAX_COLLAB_ROLES} Rollen gemeinsam an einer Aufgabe arbeiten. mode='parallel' (Standard, schneller): alle Rollen arbeiten unabhängig. mode='sequential': jede Rolle baut auf den vorherigen Beiträgen auf. Optional fasst 'KI-Koordination' alles zusammen. Kosten: 1 KI-Aufruf pro Rolle (+1 für die Zusammenfassung); das Budget wird vorab komplett reserviert.`,
			{
				task: z.string().min(1).max(MAX_TASK_CHARS),
				roles: z.array(z.string().min(1).max(100)).min(2).max(MAX_COLLAB_ROLES).describe("Rollen-IDs oder -Namen"),
				mode: z.enum(["parallel", "sequential"]).default("parallel"),
				synthesize: z.boolean().default(true).describe("Ergebnisse durch 'KI-Koordination' zusammenfassen lassen"),
			},
			async ({ task, roles: wanted, mode, synthesize }) =>
				this.safe(async () => {
				const roles = await this.roles();
				const chosen: Role[] = [];
				for (const w of wanted) {
					const r = resolveRole(roles, w);
					if (!r) return err(`Rolle '${w}' nicht gefunden. Verfügbar: ${roles.map((x) => x.name).join(", ")}`);
					if (!chosen.some((c) => c.id === r.id)) chosen.push(r);
				}
				if (chosen.length < 2) return err("Bitte mindestens zwei verschiedene Rollen angeben.");
				const coord = synthesize ? this.coordinator(roles) : undefined;
				if (synthesize && !coord) return err(`Koordinator-Rolle '${this.env.COORDINATOR_ROLE}' nicht gefunden.`);

				const units = chosen.length + (coord ? 1 : 0);
				const { denied } = await this.reserve(units);
				if (denied) return denied;

				let used = 0;
				const results: { role: Role; res?: RunResult; error?: string }[] = [];
				try {
					if (mode === "parallel") {
						used += chosen.length;
						const settled = await Promise.allSettled(chosen.map((r) => this.backend.run(r.id, task)));
						settled.forEach((s, i) =>
							results.push(
								s.status === "fulfilled" ? { role: chosen[i], res: s.value } : { role: chosen[i], error: errorText(s.reason) },
							),
						);
					} else {
						for (const r of chosen) {
							const prior = results
								.filter((x) => x.res)
								.map((x) => `Beitrag von ${x.role.name}:\n${x.res!.output}`)
								.join("\n\n");
							used++;
							try {
								const res = await this.backend.run(
									r.id,
									task,
									prior ? clip(`Bisherige Beiträge des Teams – baue darauf auf, ergänze und korrigiere:\n\n${prior}`, MAX_CONTEXT_CHARS) : undefined,
								);
								results.push({ role: r, res });
							} catch (e) {
								results.push({ role: r, error: errorText(e) });
							}
						}
					}

					const good = results.filter((x) => x.res);
					let synthesis: RunResult | undefined;
					let synthesisNote = "";
					if (coord) {
						if (good.length >= 1) {
							used++;
							try {
								synthesis = await this.backend.run(
									coord.id,
									`Fasse die Beiträge des Teams zur folgenden Aufgabe zu einem klaren Gesamtergebnis zusammen. Benenne Übereinstimmungen, Widersprüche und konkrete nächste Schritte.\n\nAufgabe:\n${task}`,
									clip(good.map((x) => `Beitrag von ${x.role.name}:\n${x.res!.output}`).join("\n\n"), MAX_CONTEXT_CHARS),
								);
							} catch (e) {
								synthesisNote = `Zusammenfassung fehlgeschlagen: ${errorText(e)}`;
							}
						} else {
							synthesisNote = "Keine Zusammenfassung, da kein Beitrag erfolgreich war.";
						}
					}
					await this.release(units - used);

					const parts = results.map((x) => (x.res ? formatRun(x.res, x.role.name) : `### ${x.role.name}\n\n⚠️ ${x.error}`));
					if (synthesis) parts.push(formatRun(synthesis, coord!.name, `Zusammenfassung (${coord!.name})`));
					if (synthesisNote) parts.push(synthesisNote);
					const s = await limiterStub(this.env).status("ai", this.limits().daily);
					return { content: [{ type: "text", text: `${parts.join("\n\n")}\n\n---\n${describeLimit(s)}` }], isError: good.length === 0 };
				} catch (e) {
					await this.release(units - used);
					throw e;
				}
			}),
		);

		// 6) Nutzung – kein KI-Aufruf
		this.server.tool(
			"ki_team_usage",
			"Zeigt die heutige Nutzung und verbleibenden KI-Aufrufe (MCP-Limit und – falls verfügbar – das Limit des Hauptworkers). Verursacht keinen KI-Aufruf.",
			{},
			async () =>
				this.safe(async () => {
				const s = await limiterStub(this.env).status("ai", this.limits().daily);
				let backendLine = "Hauptworker-Limit: nicht abrufbar.";
				try {
					const u = await this.backend.usage();
					if (typeof u.used === "number" && typeof u.limit === "number") {
						backendLine = `Hauptworker-Limit: ${u.used}/${u.limit} genutzt${typeof u.remaining === "number" ? `, ${u.remaining} frei` : ""}${u.resetsAt ? ` – Reset ${u.resetsAt}` : ""}.`;
					}
				} catch (e) {
					backendLine = `Hauptworker-Limit: nicht abrufbar (${errorText(e)}).`;
				}
				return ok(`${describeLimit(s)}\n${backendLine}\nPro Minute max. ${this.limits().perMinute} KI-Aufrufe über MCP.`);
			}),
		);
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
