// End-to-End-Test: startet den MCP-Worker + Hauptworker-Attrappe lokal (wrangler dev)
// und eine GitHub-Attrappe, spielt den kompletten OAuth-Ablauf wie Claude durch
// und ruft danach alle MCP-Tools auf. Läuft in GitHub Actions (kein lokaler PC nötig).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BASE = "http://127.0.0.1:8788";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ALLOWED_ID = 340084289;
const SECRETS = ["test-workspace-pw", "test-client-secret", "test-or-key"];

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
	if (cond) {
		passed++;
		console.log(`  ✔ ${name}`);
	} else {
		failures.push(`${name} ${detail}`);
		console.log(`  ✘ ${name} ${detail}`);
	}
}

// ---------- GitHub-Attrappe ----------
const gh = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	const url = new URL(req.url, "http://x");
	res.setHeader("content-type", "application/json");
	if (url.pathname === "/login/oauth/access_token") {
		const p = new URLSearchParams(body);
		if (p.get("client_secret") !== "test-client-secret") return res.end(JSON.stringify({ error: "bad_secret" }));
		const code = p.get("code");
		return res.end(JSON.stringify(code === "gh-ok" || code === "gh-intruder" ? { access_token: `tok-${code}` } : { error: "bad_verification_code" }));
	}
	if (url.pathname === "/user") {
		const auth = req.headers.authorization;
		if (auth === "Bearer tok-gh-ok") return res.end(JSON.stringify({ id: ALLOWED_ID, login: "yannikzehnderyz-coder" }));
		if (auth === "Bearer tok-gh-intruder") return res.end(JSON.stringify({ id: 1, login: "intruder" }));
		res.statusCode = 401;
		return res.end("{}");
	}
	res.statusCode = 404;
	res.end("{}");
});
await new Promise((r) => gh.listen(8790, "127.0.0.1", r));

// ---------- OpenRouter-Attrappe ----------
const FREE_A = "mock/a:free";
const FREE_B = "mock/b:free";
const modelCalls = [];
const orServer = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	res.setHeader("content-type", "application/json");
	if (req.url === "/api/v1/models") {
		return res.end(JSON.stringify({ data: [
			{ id: "paid/expensive", pricing: { prompt: "0.001", completion: "0.002" } },
			{ id: "trap/fake:free", pricing: { prompt: "0", completion: "0.000001" } },
			{ id: FREE_A, pricing: { prompt: "0", completion: "0", request: "0" } },
			{ id: FREE_B, pricing: { prompt: "0", completion: "0" } },
		] }));
	}
	if (req.url === "/api/v1/chat/completions") {
		if (req.headers.authorization !== "Bearer test-or-key") { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: "no key" } })); }
		const b = JSON.parse(body);
		modelCalls.push(b.model);
		const role = (b.messages?.[0]?.content.match(/Spezialist für (.+)\. Antworte/) ?? [])[1] ?? "?";
		const user = b.messages?.[1]?.content ?? "";
		const down = (user.includes("MODEL_DOWN") && b.model === FREE_A) || (role === "SEO" && user.includes("FAIL_ROLE"));
		if (down) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: "Provider down" } })); }
		let content = `MOCK-ANTWORT von ${role}: ${user.split("\n---\nKontext:")[0].slice(0, 40)}${user.includes("Kontext:") ? " [mit Kontext]" : ""}`;
		if (role === "KI-Koordination" && user.includes("AUSSCHLIESSLICH mit JSON")) content = 'Hier: {"roles":["Marketing","SEO","gibtsnicht"],"reason":"Marketingthema"}';
		return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
	}
	res.statusCode = 404; res.end("{}");
});
await new Promise((r) => orServer.listen(8791, "127.0.0.1", r));

// ---------- wrangler dev ----------
let wr;
let wrLog = "";
function startWrangler(args) {
	wrLog = "";
	wr = spawn("npx", ["wrangler", "dev", ...args], { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
	wr.stdout.on("data", (d) => (wrLog += d));
	wr.stderr.on("data", (d) => (wrLog += d));
}
async function stopWrangler() {
	if (!wr) return;
	const p = new Promise((r) => wr.once("exit", r));
	wr.kill("SIGTERM");
	await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
	wr = undefined;
}
async function waitReady(base) {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`${base}/`);
			if (r.status === 200) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`wrangler dev nicht bereit:\n${wrLog.slice(-4000)}`);
}
startWrangler(["-c", "wrangler.test.jsonc", "-c", "test/main-worker.wrangler.jsonc", "--persist-to", ".wrangler/e2e-state"]);

function cookiesFrom(res) {
	const out = {};
	for (const c of res.headers.getSetCookie?.() ?? []) {
		const [kv] = c.split(";");
		const i = kv.indexOf("=");
		out[kv.slice(0, i)] = kv.slice(i + 1);
	}
	return out;
}

let allOutput = "";
const finish = async (code) => {
	await stopWrangler();
	gh.close();
	orServer.close();
	console.log(`\nErgebnis: ${passed} bestanden, ${failures.length} fehlgeschlagen`);
	if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));
	process.exit(code);
};

try {
	await waitReady(BASE);
	console.log("wrangler dev läuft.\n");

	console.log("1) Unauthentifizierter Zugriff");
	let r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	check("/mcp ohne Token → 401", r.status === 401, `(war ${r.status})`);
	check("401 enthält WWW-Authenticate", !!r.headers.get("www-authenticate"));
	r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer gefaelscht", "content-type": "application/json" }, body: "{}" });
	check("/mcp mit falschem Token → 401", r.status === 401, `(war ${r.status})`);

	console.log("2) Discovery");
	r = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
	const meta = await r.json().catch(() => ({}));
	check("Authorization-Server-Metadaten vorhanden", r.ok && !!meta.authorization_endpoint && !!meta.token_endpoint);
	check("PKCE S256 wird angeboten", (meta.code_challenge_methods_supported ?? []).includes("S256"));
	r = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
	check("Protected-Resource-Metadaten vorhanden", r.ok, `(war ${r.status})`);

	console.log("3) Client-Registrierung");
	r = await fetch(`${BASE}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Böse", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
	});
	check("Fremde Redirect-URI wird abgelehnt", r.status === 400, `(war ${r.status})`);
	r = await fetch(`${BASE}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
	});
	const client = await r.json().catch(() => ({}));
	check("Claude-Client wird registriert", r.status === 201 && !!client.client_id, `(war ${r.status} ${JSON.stringify(client)})`);

	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const authUrl = (extra = {}) => {
		const u = new URL(`${BASE}/authorize`);
		const p = { response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state-123", ...extra };
		for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v);
		return u.href;
	};

	console.log("4) /authorize-Prüfungen");
	r = await fetch(authUrl({ code_challenge: null, code_challenge_method: null }));
	check("Ohne PKCE → abgelehnt", r.status === 400, `(war ${r.status})`);
	r = await fetch(authUrl({ code_challenge_method: "plain", code_challenge: verifier }));
	check("PKCE plain → abgelehnt", r.status === 400, `(war ${r.status})`);
	r = await fetch(authUrl({ redirect_uri: "https://evil.example/cb" }));
	check("Fremde redirect_uri → abgelehnt", r.status >= 400, `(war ${r.status})`);

	async function startLogin() {
		const res = await fetch(authUrl(), { redirect: "manual" });
		const html = await res.text();
		const csrf = cookiesFrom(res)["__Host-kiteam_csrf"];
		const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
		return { status: res.status, html, csrf, requestId };
	}
	const login = await startLogin();
	check("Freigabeseite wird angezeigt", login.status === 200 && !!login.csrf && !!login.requestId);
	check("Freigabeseite enthält keine OAuth-Rohdaten", !login.html.includes(challenge) && !login.html.includes("claude-state-123"));

	console.log("5) CSRF");
	r = await fetch(`${BASE}/authorize`, {
		method: "POST", redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-kiteam_csrf=${login.csrf}` },
		body: new URLSearchParams({ request_id: login.requestId, csrf: "falsch" }),
	});
	check("Falsches CSRF-Token → 403", r.status === 403, `(war ${r.status})`);
	r = await fetch(`${BASE}/authorize`, {
		method: "POST", redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ request_id: login.requestId, csrf: login.csrf }),
	});
	check("Ohne CSRF-Cookie → abgelehnt", r.status === 400, `(war ${r.status})`);

	async function approve(l) {
		const res = await fetch(`${BASE}/authorize`, {
			method: "POST", redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-kiteam_csrf=${l.csrf}` },
			body: new URLSearchParams({ request_id: l.requestId, csrf: l.csrf }),
		});
		const loc = res.headers.get("location") ?? "";
		return { status: res.status, state: new URL(loc, BASE).searchParams.get("state"), binding: cookiesFrom(res)["__Host-kiteam_state"], loc };
	}
	const ap = await approve(login);
	check("Weiterleitung zu GitHub", ap.status === 302 && ap.loc.startsWith("http://127.0.0.1:8790/login/oauth/authorize") && !!ap.state && !!ap.binding, ap.loc);

	console.log("6) GitHub-Callback");
	r = await fetch(`${BASE}/callback?code=gh-ok&state=${ap.state}`, { redirect: "manual" });
	check("Callback ohne Browser-Bindung → abgelehnt", r.status === 400 || r.status === 403, `(war ${r.status})`);
	// state wurde nicht verbraucht, weil der Cookie fehlte? -> Neuer Durchlauf für saubere Tests
	const login2 = await startLogin();
	const ap2 = await approve(login2);
	r = await fetch(`${BASE}/callback?code=gh-intruder&state=${ap2.state}`, { redirect: "manual", headers: { cookie: `__Host-kiteam_state=${ap2.binding}` } });
	check("Fremder GitHub-Account → 403", r.status === 403, `(war ${r.status})`);

	const login3 = await startLogin();
	const ap3 = await approve(login3);
	r = await fetch(`${BASE}/callback?code=gh-ok&state=${ap3.state}`, { redirect: "manual", headers: { cookie: `__Host-kiteam_state=${ap3.binding}` } });
	const back = new URL(r.headers.get("location") ?? "about:blank");
	check("Erlaubter Account → Redirect zu Claude mit Code", r.status === 302 && back.href.startsWith(CLAUDE_REDIRECT) && !!back.searchParams.get("code"), back.href);
	check("Claude-state wird zurückgegeben", back.searchParams.get("state") === "claude-state-123");
	r = await fetch(`${BASE}/callback?code=gh-ok&state=${ap3.state}`, { redirect: "manual", headers: { cookie: `__Host-kiteam_state=${ap3.binding}` } });
	check("state ist nur einmal verwendbar", r.status === 400, `(war ${r.status})`);

	console.log("7) Token-Ausgabe");
	const tokenReq = (v) =>
		fetch(`${BASE}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: CLAUDE_REDIRECT, client_id: client.client_id, code_verifier: v }),
		});
	r = await tokenReq("falscher-verifier-falscher-verifier-falscher-verifier");
	check("Falscher PKCE-Verifier → abgelehnt", r.status >= 400, `(war ${r.status})`);
	// Code nach Fehlversuch evtl. ungültig → frischen Code holen
	const login4 = await startLogin();
	const ap4 = await approve(login4);
	r = await fetch(`${BASE}/callback?code=gh-ok&state=${ap4.state}`, { redirect: "manual", headers: { cookie: `__Host-kiteam_state=${ap4.binding}` } });
	const back4 = new URL(r.headers.get("location") ?? "about:blank");
	r = await fetch(`${BASE}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code: back4.searchParams.get("code"), redirect_uri: CLAUDE_REDIRECT, client_id: client.client_id, code_verifier: verifier }),
	});
	const tok = await r.json().catch(() => ({}));
	check("Access-Token wird ausgestellt", r.ok && !!tok.access_token, JSON.stringify(tok));
	check("Refresh-Token wird ausgestellt", !!tok.refresh_token);

	console.log("8) MCP");
	let session;
	let rpcId = 0;
	async function rpc(method, params, notify = false) {
		const headers = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
		if (session) headers["mcp-session-id"] = session;
		const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params };
		const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
		session = res.headers.get("mcp-session-id") ?? session;
		const text = await res.text();
		allOutput += text;
		if (notify) return { status: res.status };
		let msg;
		if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
			for (const line of text.split("\n")) {
				if (line.startsWith("data:")) {
					try {
						const j = JSON.parse(line.slice(5));
						if (j.id === body.id) msg = j;
					} catch {}
				}
			}
		} else {
			try { msg = JSON.parse(text); } catch {}
		}
		return { status: res.status, msg, text };
	}
	const callTool = async (name, args = {}) => {
		const res = await rpc("tools/call", { name, arguments: args });
		const result = res.msg?.result;
		return { text: result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(res.msg ?? res.text).slice(0, 500), isError: !!result?.isError };
	};

	const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
	check("MCP initialize", init.status === 200 && !!init.msg?.result?.serverInfo, `(${init.status} ${init.text?.slice(0, 300)})`);
	await rpc("notifications/initialized", {}, true);
	const list = await rpc("tools/list", {});
	const names = (list.msg?.result?.tools ?? []).map((t) => t.name).sort();
	const expected = ["ki_team_auto_delegate", "ki_team_collaborate", "ki_team_list_roles", "ki_team_run_role", "ki_team_status", "ki_team_usage"];
	check("Alle 6 Tools vorhanden", JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
	check("Demo-Tool 'add' entfernt", !names.includes("add"));

	let t = await callTool("ki_team_status");
	check("ki_team_status", !t.isError && t.text.includes("erreichbar: ja") && t.text.includes("26 Rollen"), t.text);
	t = await callTool("ki_team_list_roles");
	check("ki_team_list_roles liefert 26 Rollen", !t.isError && t.text.startsWith("26 Rollen") && t.text.includes("KI-Koordination"), t.text.slice(0, 200));

	t = await callTool("ki_team_run_role", { role: "marketing", task: "Strategie für Gartencenter" });
	check("ki_team_run_role erreicht Hauptworker + OpenRouter", !t.isError && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes(FREE_A) && t.text.includes("11/12"), t.text);
	t = await callTool("ki_team_run_role", { role: "Gibt es nicht", task: "x" });
	check("Unbekannte Rolle → Fehler ohne Verbrauch", t.isError && t.text.includes("nicht gefunden"), t.text);

	t = await callTool("ki_team_auto_delegate", { task: "Wie bewerbe ich meinen Shop?" });
	check("ki_team_auto_delegate wählt Rolle und führt aus", !t.isError && t.text.includes("Vorgeschlagene Rollen: Marketing, SEO") && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes("9/12"), t.text);

	t = await callTool("ki_team_collaborate", { task: "Login-System bauen", roles: ["Programmierung", "Sicherheit"] });
	check("ki_team_collaborate parallel + Zusammenfassung", !t.isError && t.text.includes("MOCK-ANTWORT von Programmierung") && t.text.includes("MOCK-ANTWORT von Sicherheit") && t.text.includes("Zusammenfassung (KI-Koordination)") && t.text.includes("6/12"), t.text);

	t = await callTool("ki_team_collaborate", { task: "FAIL_ROLE Kampagne", roles: ["Marketing", "SEO"], mode: "sequential" });
	check("ki_team_collaborate sequenziell, Teilfehler wird gemeldet", !t.isError && t.text.includes("model_unavailable") && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes("[mit Kontext]") && t.text.includes("3/12"), t.text);

	t = await callTool("ki_team_collaborate", { task: "zu teuer", roles: ["Marketing", "SEO", "Recherche"] });
	check("Collaborate wird vorab abgelehnt, wenn Budget nicht reicht", t.isError && t.text.includes("Tageslimit erreicht"), t.text);

	t = await callTool("ki_team_usage");
	check("ki_team_usage zeigt beide Limits", !t.isError && t.text.includes("3/12") && /Hauptworker-Limit: \d+\/20 genutzt/.test(t.text), t.text);

	console.log("9) Atomares Limit bei parallelen Aufrufen");
	const par = await Promise.all(Array.from({ length: 6 }, (_, i) => callTool("ki_team_run_role", { role: "Recherche", task: `parallel ${i}` })));
	const okCount = par.filter((x) => !x.isError).length;
	check("Genau 3 von 6 parallelen Aufrufen erlaubt (Restbudget 3)", okCount === 3, `(erlaubt: ${okCount})`);
	t = await callTool("ki_team_run_role", { role: "Recherche", task: "danach" });
	check("Nach Erreichen des Limits → abgelehnt", t.isError && t.text.includes("Tageslimit"), t.text);

	console.log("10) Keine Secrets in Antworten");
	check("Keine Secrets in MCP-Ausgaben", !SECRETS.some((s) => allOutput.includes(s)));

	console.log("11) Hauptworker direkt (Weboberfläche + Schutz der internen API)");
	await stopWrangler();
	const UI = "http://127.0.0.1:8789";
	startWrangler(["-c", "test/main-worker.wrangler.jsonc", "--port", "8789", "--ip", "127.0.0.1", "--var", "DAILY_REQUEST_LIMIT:3", "--persist-to", ".wrangler/ui-state"]);
	await waitReady(UI);
	r = await fetch(`${UI}/`);
	check("Weboberfläche lädt", (await r.text()).includes("26 Agenten"));
	const chat = (pw, task, role = "Marketing") =>
		fetch(`${UI}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-workspace-password": pw }, body: JSON.stringify({ role, task }) });
	r = await chat("falsch", "x");
	check("/api/chat mit falschem Passwort → 401", r.status === 401, `(war ${r.status})`);
	// timingSafeEqual: unterschiedliche Längen dürfen keine Ausnahme (500) auslösen
	r = await fetch(`${UI}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "SEO", task: "x" }) });
	check("Ohne Passwort-Header → 401 (keine Ausnahme)", r.status === 401, `(war ${r.status})`);
	r = await chat("", "x");
	check("Leeres Passwort → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("x".repeat(5000), "x");
	check("Sehr langes Passwort → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("test-workspace-pX", "x");
	check("Gleich langes, falsches Passwort → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("test-workspace-pw ", "x");
	check("Passwort mit Zusatzzeichen → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("ÄÖÜ-ß-😀", "x");
	check("Sonderzeichen-Passwort → 401", r.status === 401, `(war ${r.status})`);
	for (const path of ["roles", "usage", "health"]) {
		r = await fetch(`${UI}/api/mcp/v1/${path}`);
		check(`/api/mcp/v1/${path} ohne Passwort → 401`, r.status === 401, `(war ${r.status})`);
	}
	r = await fetch(`${UI}/api/mcp/v1/run`, { method: "POST", headers: { "x-workspace-password": "falsch", "content-type": "application/json" }, body: JSON.stringify({ roleId: "SEO", task: "x" }) });
	check("/api/mcp/v1/run mit falschem Passwort → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("test-workspace-pw", "Hallo Team");
	let d = await r.json();
	check("/api/chat liefert Antwort", r.ok && d.answer?.includes("MOCK-ANTWORT von Marketing"), JSON.stringify(d));
	r = await chat("test-workspace-pw", "MODEL_DOWN bitte");
	d = await r.json();
	check("Fallback auf zweites Free-Modell", r.ok && d.model === FREE_B, JSON.stringify(d));
	r = await chat("test-workspace-pw", "dritte");
	check("3. Anfrage erlaubt", r.ok);
	r = await chat("test-workspace-pw", "vierte");
	check("Tageslimit des Hauptworkers greift (429)", r.status === 429, `(war ${r.status})`);
	r = await fetch(`${UI}/api/mcp/v1/usage`, { headers: { "x-workspace-password": "test-workspace-pw" } });
	d = await r.json();
	check("Nutzung wird korrekt gemeldet", d.used === 3 && d.limit === 3 && d.remaining === 0, JSON.stringify(d));

	console.log("12) Kostenschutz");
	check("Nur :free-Modelle wurden aufgerufen", modelCalls.length > 0 && modelCalls.every((m) => m === FREE_A || m === FREE_B), JSON.stringify(modelCalls));
	check("Kostenpflichtiges / falsch markiertes Modell nie benutzt", !modelCalls.includes("paid/expensive") && !modelCalls.includes("trap/fake:free"));

	await finish(failures.length ? 1 : 0);
} catch (e) {
	console.error("Testabbruch:", e);
	console.error(wrLog.slice(-4000));
	failures.push(`Abbruch: ${e.message}`);
	await finish(1);
}
