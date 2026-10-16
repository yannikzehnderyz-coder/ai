/**
 * Echte Anmeldung für den MCP-Server (ersetzt die Demo-Anmeldung der Vorlage).
 *
 * Ablauf:
 *  1. Claude startet OAuth (Authorization Code + PKCE S256) bei /authorize.
 *  2. Wir prüfen Client, Redirect-URI (nur Claude) und PKCE und zeigen eine
 *     Freigabeseite. Die OAuth-Anfrage bleibt serverseitig in KV gespeichert –
 *     das Formular enthält nur eine zufällige ID (nicht manipulierbar).
 *  3. Nach Klick (CSRF-geschützt) Weiterleitung zu GitHub.
 *  4. /callback: state wird einmalig verbraucht und an den Browser gebunden,
 *     GitHub-Identität wird geprüft. Nur die erlaubte GitHub-Benutzer-ID
 *     erhält ein Token. Das GitHub-Token wird danach verworfen.
 *
 * Warum GitHub statt Cloudflare Access? Cloudflare Zero Trust verlangt auch im
 * Free-Tarif die Hinterlegung von Zahlungsdaten – das ist ausgeschlossen.
 * Eine GitHub-OAuth-App ist kostenlos und ohne Zahlungsdaten nutzbar.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { consentPage, errorPage, homePage } from "./html";

export type Props = {
	githubId: number;
	login: string;
};

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const AUTHREQ_TTL = 600; // 10 Minuten
const CSRF_COOKIE = "__Host-kiteam_csrf";
const STATE_COOKIE = "__Host-kiteam_state";

const app = new Hono<{ Bindings: Bindings }>();

// ---------- Hilfsfunktionen ----------

function randomToken(bytes = 32): string {
	const a = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

function getCookie(req: Request, name: string): string | undefined {
	const header = req.headers.get("cookie") ?? "";
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return undefined;
}

function cookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function csvSet(value: string | undefined): Set<string> {
	return new Set(
		String(value ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

export function isAllowedRedirect(env: Env, uri: string): boolean {
	return csvSet(env.ALLOWED_REDIRECT_URIS).has(uri);
}

const noStore = {
	"Cache-Control": "no-store",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
	"Referrer-Policy": "no-referrer",
};

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", ...noStore, ...extra },
	});
}

function fail(status: number, message: string): Response {
	return html(errorPage(message), status);
}

// ---------- Routen ----------

app.get("/", () => html(homePage()));

app.get("/authorize", async (c) => {
	let oauthReqInfo: AuthRequest;
	try {
		// prüft client_id und ob redirect_uri zum registrierten Client gehört
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		return fail(400, "Ungültige OAuth-Anfrage.");
	}
	if (!oauthReqInfo.clientId) return fail(400, "Ungültige OAuth-Anfrage (Client fehlt).");
	if (oauthReqInfo.responseType !== "code") return fail(400, "Nur der Authorization-Code-Flow ist erlaubt.");
	if (!oauthReqInfo.codeChallenge || oauthReqInfo.codeChallengeMethod !== "S256") {
		return fail(400, "PKCE (S256) ist erforderlich.");
	}
	if (!isAllowedRedirect(c.env, oauthReqInfo.redirectUri)) {
		return fail(400, "Diese Redirect-URI ist nicht freigegeben. Nur Claude darf sich verbinden.");
	}

	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	if (!client) return fail(400, "Unbekannter Client.");

	const requestId = randomToken();
	const csrf = randomToken();
	await c.env.OAUTH_KV.put(
		`kiteam:authreq:${requestId}`,
		JSON.stringify({ oauthReqInfo, csrfHash: await sha256(csrf) }),
		{ expirationTtl: AUTHREQ_TTL },
	);

	return html(
		consentPage({
			clientName: client.clientName || "Unbenannter Client",
			redirectHost: new URL(oauthReqInfo.redirectUri).host,
			requestId,
			csrf,
		}),
		200,
		{ "Set-Cookie": cookie(CSRF_COOKIE, csrf, AUTHREQ_TTL) },
	);
});

app.post("/authorize", async (c) => {
	const form = await c.req.raw.formData().catch(() => null);
	const requestId = form?.get("request_id");
	const csrfForm = form?.get("csrf");
	const csrfCookie = getCookie(c.req.raw, CSRF_COOKIE);
	if (typeof requestId !== "string" || typeof csrfForm !== "string" || !csrfCookie) {
		return fail(400, "Formular unvollständig oder Sitzung abgelaufen. Bitte die Verbindung in Claude neu starten.");
	}
	if (!timingSafeEqual(csrfForm, csrfCookie)) return fail(403, "CSRF-Prüfung fehlgeschlagen.");

	const key = `kiteam:authreq:${requestId}`;
	const stored = await c.env.OAUTH_KV.get<{ oauthReqInfo: AuthRequest; csrfHash: string }>(key, "json");
	if (!stored) return fail(400, "Anfrage abgelaufen. Bitte die Verbindung in Claude neu starten.");
	await c.env.OAUTH_KV.delete(key);
	if (!timingSafeEqual(await sha256(csrfForm), stored.csrfHash)) return fail(403, "CSRF-Prüfung fehlgeschlagen.");

	// state an diesen Browser binden (Schutz gegen Login-CSRF / State-Injection)
	const state = randomToken();
	const browserBinding = randomToken();
	await c.env.OAUTH_KV.put(
		`kiteam:state:${state}`,
		JSON.stringify({ oauthReqInfo: stored.oauthReqInfo, bindingHash: await sha256(browserBinding) }),
		{ expirationTtl: AUTHREQ_TTL },
	);

	const githubWeb = c.env.GITHUB_WEB_BASE || "https://github.com";
	const url = new URL(`${githubWeb}/login/oauth/authorize`);
	url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", c.req.url).href);
	url.searchParams.set("state", state);
	url.searchParams.set("allow_signup", "false");
	// kein scope => nur öffentliche Profildaten, keine Repo-Rechte

	const headers = new Headers({ Location: url.href, ...noStore });
	headers.append("Set-Cookie", cookie(STATE_COOKIE, browserBinding, AUTHREQ_TTL));
	headers.append("Set-Cookie", cookie(CSRF_COOKIE, "", 0));
	return new Response(null, { status: 302, headers });
});

app.get("/callback", async (c) => {
	const state = c.req.query("state");
	const code = c.req.query("code");
	const binding = getCookie(c.req.raw, STATE_COOKIE);
	if (!state || !code || !binding) return fail(400, "Ungültige Rückmeldung von GitHub.");

	const key = `kiteam:state:${state}`;
	const stored = await c.env.OAUTH_KV.get<{ oauthReqInfo: AuthRequest; bindingHash: string }>(key, "json");
	if (!stored) return fail(400, "Anmeldung abgelaufen oder bereits verwendet.");
	await c.env.OAUTH_KV.delete(key); // einmalig verwendbar
	if (!timingSafeEqual(await sha256(binding), stored.bindingHash)) {
		return fail(403, "Diese Anmeldung wurde in einem anderen Browser gestartet.");
	}

	// Code gegen GitHub-Token tauschen
	const githubWeb = c.env.GITHUB_WEB_BASE || "https://github.com";
	const githubApi = c.env.GITHUB_API_BASE || "https://api.github.com";
	let ghToken: string | undefined;
	try {
		const tokenRes = await fetch(`${githubWeb}/login/oauth/access_token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: c.env.GITHUB_CLIENT_ID,
				client_secret: c.env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: new URL("/callback", c.req.url).href,
			}).toString(),
		});
		const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
		ghToken = tokenJson.access_token;
	} catch {
		ghToken = undefined;
	}
	if (!ghToken) return fail(502, "GitHub-Anmeldung fehlgeschlagen.");

	let user: { id?: number; login?: string } = {};
	try {
		const userRes = await fetch(`${githubApi}/user`, {
			headers: {
				Authorization: `Bearer ${ghToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "ki-team-oauth-mcp",
			},
		});
		if (userRes.ok) user = (await userRes.json()) as typeof user;
	} catch {
		/* unten behandelt */
	}
	if (typeof user.id !== "number" || typeof user.login !== "string") {
		return fail(502, "GitHub-Profil konnte nicht gelesen werden.");
	}

	// Einziger erlaubter Nutzer
	if (!csvSet(c.env.ALLOWED_GITHUB_USER_IDS).has(String(user.id))) {
		console.warn("Abgelehnter Login-Versuch", { githubId: user.id });
		return fail(403, "Dieser GitHub-Account hat keinen Zugriff auf dieses KI-Team.");
	}

	// Doppelte Prüfung: Redirect-URI weiterhin erlaubt
	if (!isAllowedRedirect(c.env, stored.oauthReqInfo.redirectUri)) return fail(400, "Redirect-URI nicht erlaubt.");

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: stored.oauthReqInfo,
		userId: String(user.id),
		metadata: { label: user.login },
		scope: stored.oauthReqInfo.scope,
		props: { githubId: user.id, login: user.login } satisfies Props,
	});

	const headers = new Headers({ Location: redirectTo, ...noStore });
	headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
	return new Response(null, { status: 302, headers });
});

app.notFound(() => new Response("Not found", { status: 404, headers: noStore }));

export { app as AuthHandler };
