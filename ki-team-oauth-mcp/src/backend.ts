/**
 * Client für den bestehenden Hauptworker "claude-ki-team".
 *
 * Kommunikation ausschließlich über das Service-Binding KI_TEAM (kein öffentlicher
 * HTTP-Aufruf). Der Hauptworker prüft weiterhin sein Workspace-Passwort
 * (Header x-workspace-password); das Passwort liegt hier nur als Secret vor.
 *
 * Erwartete interne API des Hauptworkers (Version 1, siehe README):
 *   GET  /api/mcp/v1/health  -> { ok: true, roles?: number, version?: string }
 *   GET  /api/mcp/v1/roles   -> { roles: [{ id, name, description? }] }
 *   POST /api/mcp/v1/run     <- { roleId, task, context? }
 *                            -> { roleId, roleName?, output, model?, usage? }
 *   GET  /api/mcp/v1/usage   -> { used, limit, remaining, resetsAt? }
 * Fehler:                     -> HTTP 4xx/5xx mit { error: { code, message } }
 */

export interface Role {
	id: string;
	name: string;
	description?: string;
}

export interface BackendUsage {
	used?: number;
	limit?: number;
	remaining?: number;
	resetsAt?: string;
}

export interface RunResult {
	roleId: string;
	roleName?: string;
	output: string;
	model?: string;
	profile?: string;
	finishReason?: string;
	usage?: BackendUsage;
	cached?: boolean;
}

export type ModelProfile = "auto" | "code" | "reasoning" | "writing" | "fast" | "long";
export const MODEL_PROFILES: ModelProfile[] = ["auto", "code", "reasoning", "writing", "fast", "long"];

export interface ModelInfo {
	free: number;
	profiles?: Record<string, string[]>;
	version?: string;
}

export class BackendError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "BackendError";
	}
}

const BASE = "https://claude-ki-team.internal/api/mcp/v1";
const RUN_TIMEOUT_MS = 120_000;
const META_TIMEOUT_MS = 15_000;

export class KiTeamBackend {
	constructor(private readonly env: Env) {}

	private async call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
		if (!this.env.KI_TEAM_PASSWORD) {
			throw new BackendError(
				"Das Secret KI_TEAM_PASSWORD ist im MCP-Worker nicht gesetzt.",
				500,
				"not_configured",
			);
		}
		const headers = new Headers(init.headers);
		headers.set("x-workspace-password", this.env.KI_TEAM_PASSWORD);
		headers.set("accept", "application/json");
		if (init.body) headers.set("content-type", "application/json");

		let res: Response;
		try {
			res = await this.env.KI_TEAM.fetch(`${BASE}${path}`, {
				...init,
				headers,
				signal: AbortSignal.timeout(init.timeoutMs ?? META_TIMEOUT_MS),
			});
		} catch (err) {
			const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
			throw new BackendError(
				timeout
					? "Der Hauptworker hat nicht rechtzeitig geantwortet (Zeitüberschreitung)."
					: "Der Hauptworker ist über das Service-Binding nicht erreichbar.",
				timeout ? 504 : 502,
				timeout ? "timeout" : "unreachable",
			);
		}

		const text = await res.text();
		let data: unknown = undefined;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			data = undefined;
		}

		if (!res.ok) {
			const e = (data as { error?: { code?: string; message?: string } | string } | undefined)?.error;
			const code = typeof e === "object" && e?.code ? e.code : `http_${res.status}`;
			const message =
				typeof e === "object" && e?.message
					? e.message
					: typeof e === "string"
						? e
						: res.status === 404
							? "Der Hauptworker bietet die interne MCP-API (/api/mcp/v1) noch nicht an."
							: res.status === 401 || res.status === 403
								? "Der Hauptworker hat das Workspace-Passwort abgelehnt (KI_TEAM_PASSWORD prüfen)."
								: `Der Hauptworker meldet HTTP ${res.status}.`;
			throw new BackendError(message, res.status, code);
		}
		if (data === undefined || typeof data !== "object" || data === null) {
			throw new BackendError("Der Hauptworker hat keine gültige JSON-Antwort geliefert.", 502, "bad_response");
		}
		return data as T;
	}

	health() {
		return this.call<{ ok: boolean; roles?: number; version?: string }>("/health");
	}

	async roles(): Promise<Role[]> {
		const data = await this.call<{ roles?: unknown }>("/roles");
		if (!Array.isArray(data.roles)) {
			throw new BackendError("Rollenliste des Hauptworkers hat ein unerwartetes Format.", 502, "bad_response");
		}
		return data.roles
			.filter((r): r is Role => !!r && typeof r === "object" && typeof (r as Role).id === "string" && typeof (r as Role).name === "string")
			.map((r) => ({ id: r.id, name: r.name, description: typeof r.description === "string" ? r.description : undefined }));
	}

	async run(roleId: string, task: string, context?: string, profile?: ModelProfile): Promise<RunResult> {
		const data = await this.call<RunResult>("/run", {
			method: "POST",
			body: JSON.stringify({ roleId, task, context: context || undefined, profile: profile && profile !== "auto" ? profile : undefined }),
			timeoutMs: RUN_TIMEOUT_MS,
		});
		if (typeof data.output !== "string") {
			throw new BackendError("Der Hauptworker hat keine Ausgabe geliefert.", 502, "bad_response");
		}
		return data;
	}

	usage() {
		return this.call<BackendUsage>("/usage");
	}

	/** Free-Modelle und Routing-Profile (ab Hauptworker v3; ältere Versionen -> 404). */
	models() {
		return this.call<ModelInfo>("/models");
	}
}

/** Findet eine Rolle anhand von ID oder Name (Groß-/Kleinschreibung, Bindestriche und Umlaute tolerant). */
export function resolveRole(roles: Role[], query: string): Role | undefined {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/ß/g, "ss")
			.replace(/[^a-z0-9]+/g, "");
	const q = norm(query);
	if (!q) return undefined;
	return (
		roles.find((r) => r.id === query) ??
		roles.find((r) => norm(r.id) === q || norm(r.name) === q) ??
		(() => {
			const partial = roles.filter((r) => norm(r.name).includes(q) || q.includes(norm(r.name)));
			return partial.length === 1 ? partial[0] : undefined;
		})()
	);
}
