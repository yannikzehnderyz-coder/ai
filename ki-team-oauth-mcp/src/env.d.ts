// Typdefinitionen für die Bindings aus wrangler.jsonc (+ Secrets).
declare namespace Cloudflare {
	interface Env {
		OAUTH_KV: KVNamespace;
		MCP_OBJECT: DurableObjectNamespace<import("./index").MyMCP>;
		USAGE_LIMITER: DurableObjectNamespace<import("./limiter").UsageLimiter>;
		KI_TEAM: Fetcher;

		// Secrets
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		KI_TEAM_PASSWORD: string;

		// Vars
		ALLOWED_GITHUB_USER_IDS: string;
		ALLOWED_REDIRECT_URIS: string;
		MCP_DAILY_LIMIT: string;
		MCP_PER_MINUTE_LIMIT: string;
		COORDINATOR_ROLE: string;

		// Nur für automatisierte Tests (lokale Attrappe statt github.com). In Produktion nicht gesetzt.
		GITHUB_WEB_BASE?: string;
		GITHUB_API_BASE?: string;
	}
}
interface Env extends Cloudflare.Env {}
