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
	if (url.pathname === "/repos/yannikzehnderyz-coder/demo/pulls/7/files") {
		return res.end(JSON.stringify([
			{ filename: "src/db.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n const db = open();\n+const q = `SELECT * FROM users WHERE id = ${id}`;\n+el.innerHTML = userInput;" },
			{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-alt\n+neu" },
		]));
	}
	res.statusCode = 404;
	res.end("{}");
});
await new Promise((r) => gh.listen(8790, "127.0.0.1", r));

// ---------- OpenRouter-Attrappe (emuliert die Fallback-Liste "models" wie OpenRouter) ----------
const FREE_A = "mock/a:free";
const FREE_B = "mock/b:free";
const FREE_CODER = "mock/qwen-coder:free";
const FREE_R1 = "mock/deepseek-r1:free";
const FREE_C = "mock/c:free";
const FREE_D = "mock/d:free";
const FREE_SET = [FREE_A, FREE_B, FREE_CODER, FREE_R1, FREE_C, FREE_D];
const modelCalls = [];
const orRequests = [];
const orServer = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	res.setHeader("content-type", "application/json");
	if (req.url === "/api/v1/models") {
		return res.end(JSON.stringify({ data: [
			{ id: "paid/expensive", pricing: { prompt: "0.001", completion: "0.002" } },
			{ id: "trap/fake:free", pricing: { prompt: "0", completion: "0.000001" } },
			{ id: "trap/nopricing:free" },
			{ id: FREE_A, pricing: { prompt: "0", completion: "0", request: "0" } },
			{ id: FREE_B, pricing: { prompt: "0", completion: "0" } },
			{ id: "trap/super-coder:free", pricing: { prompt: "0", completion: "0", request: "0.01" } },
			{ id: "paid/qwen-coder-pro", pricing: { prompt: "0.002", completion: "0.002" } },
			{ id: FREE_CODER, context_length: 32000, pricing: { prompt: "0", completion: "0" } },
			{ id: FREE_R1, context_length: 64000, pricing: { prompt: "0", completion: "0" } },
			{ id: FREE_C, pricing: { prompt: "0", completion: "0" } },
			{ id: FREE_D, pricing: { prompt: "0", completion: "0" } },
		] }));
	}
	if (req.url === "/api/v1/chat/completions") {
		if (req.headers.authorization !== "Bearer test-or-key") { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: "no key" } })); }
		const b = JSON.parse(body);
		const list = Array.isArray(b.models) ? b.models : b.model ? [b.model] : [];
		orRequests.push({ list, provider: b.provider, model: b.model });
		modelCalls.push(...list);
		if (b.model) modelCalls.push(b.model);
		const role = (b.messages?.[0]?.content.match(/Spezialist für (.+)\. Antworte/) ?? [])[1] ?? "?";
		const user = b.messages?.[1]?.content ?? "";
		const userText = user.split("\n---\nKontext:")[0];
		if (userText.includes("DAILYLIMIT")) {
			res.statusCode = 429;
			res.setHeader("x-ratelimit-limit", "50");
			return res.end(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" } }));
		}
		let lastErr = { status: 404, error: { message: "No endpoints found" } };
		for (const m of list) {
			if (!FREE_SET.includes(m)) { lastErr = { status: 400, error: { message: `${m} not allowed in mock` } }; continue; }
			const down = (userText.includes("MODEL_DOWN") && m === FREE_A) || (role === "SEO" && userText.includes("FAIL_ROLE")) || userText.includes("ALLFAIL");
			if (down) { lastErr = { status: 503, error: { message: "Provider down", metadata: { provider_name: "MockProv" } } }; continue; }
			if (userText.includes("UPSTREAM429") && [FREE_A, FREE_B, FREE_CODER].includes(m)) {
				lastErr = { status: 429, error: { code: 429, message: `${m} is temporarily rate-limited upstream`, metadata: { provider_name: "MockProv", raw: "busy" } } };
				continue;
			}
			if (userText.includes("EMPTY") && m === FREE_R1) {
				return res.end(JSON.stringify({ model: m, choices: [{ message: { content: "" }, finish_reason: "length" }] }));
			}
			let content = `MOCK-ANTWORT von ${role}: ${userText.slice(0, 40)}${user.includes("Kontext:") ? " [mit Kontext]" : ""}${user.includes("Projektkontext") ? " [Projektkontext]" : ""}${user.includes("Farben: Grün/Weiß") ? " [Entscheidung bekannt]" : ""}`;
			let finish = "stop";
			if (role === "KI-Koordination" && user.includes("AUSSCHLIESSLICH mit JSON")) content = 'Hier: {"roles":["Marketing","SEO","gibtsnicht"],"reason":"Marketingthema"}';
			if (userText.includes("TRUNCATE") && role !== "Kritische Prüfung") {
				content = "Hier die Schritte:\n1. Ziel klären\n2. Aufgaben sammeln\n3. Zeitplan\n4. Budget\n5. Start und dann weiter mit";
				finish = "length";
			}
			if (role === "Kritische Prüfung") content = "1. Die Antwort ist unvollständig und nennt zu viele Schritte.";
			return res.end(JSON.stringify({ model: m, choices: [{ message: { content }, finish_reason: finish }] }));
		}
		res.statusCode = lastErr.status;
		return res.end(JSON.stringify({ error: lastErr.error }));
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
	check("Server-Version 3.0.0", init.msg?.result?.serverInfo?.version === "3.0.0", JSON.stringify(init.msg?.result?.serverInfo));
	await rpc("notifications/initialized", {}, true);
	const list = await rpc("tools/list", {});
	const names = (list.msg?.result?.tools ?? []).map((t) => t.name).sort();
	const legacy = ["ki_team_auto_delegate", "ki_team_collaborate", "ki_team_list_roles", "ki_team_run_role", "ki_team_status", "ki_team_usage"];
	const added = ["ki_team_pipeline", "ki_team_project_get", "ki_team_project_list", "ki_team_project_save", "ki_team_quality_check", "ki_team_review_code"];
	check("Alle 6 bisherigen Tools weiterhin vorhanden", legacy.every((n) => names.includes(n)), JSON.stringify(names));
	check("6 neue Tools vorhanden (12 gesamt)", added.every((n) => names.includes(n)) && names.length === 12, JSON.stringify(names));
	check("Demo-Tool 'add' entfernt", !names.includes("add"));

	const LIMIT = 40;
	let remaining = LIMIT;
	const rem = () => `${remaining}/${LIMIT}`;

	let t = await callTool("ki_team_status");
	check("ki_team_status", !t.isError && t.text.includes("erreichbar: ja") && t.text.includes("26 Rollen") && t.text.includes("MCP-Server 3.0.0"), t.text);
	check("Status zeigt nur kostenlose Modelle (6) und Routing", t.text.includes("Kostenlose Modelle: 6") && /code 1/.test(t.text) && /reasoning 1/.test(t.text), t.text);
	check("Status nennt Fallback-Grenzen (3 Modelle, 2 Anfragen, Preis 0)", t.text.includes("bis zu 3 Modelle je Anfrage, höchstens 2 Anfragen je Auftrag"), t.text);
	check("Hauptworker 3.1.0", t.text.includes("Version 3.1.0"), t.text);
	t = await callTool("ki_team_list_roles");
	check("ki_team_list_roles liefert 26 Rollen", !t.isError && t.text.startsWith("26 Rollen") && t.text.includes("KI-Koordination"), t.text.slice(0, 200));

	console.log("8a) Einzelauftrag, Cache, Qualitätsprüfung");
	t = await callTool("ki_team_run_role", { role: "marketing", task: "Strategie für Gartencenter" });
	remaining--;
	check("ki_team_run_role erreicht Hauptworker + OpenRouter", !t.isError && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes(FREE_A) && t.text.includes(rem()), t.text);
	check("Automatische Qualitätsprüfung ohne Befund", t.text.includes("Qualitätsprüfung: ✅"), t.text);
	t = await callTool("ki_team_run_role", { role: "marketing", task: "Strategie für Gartencenter" });
	check("Identische Anfrage kommt aus dem Cache (0 Aufrufe)", !t.isError && t.text.includes("aus Cache") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_run_role", { role: "marketing", task: "Strategie für Gartencenter", fresh: true });
	remaining--;
	check("fresh=true umgeht den Cache", !t.isError && !t.text.includes("aus Cache") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_run_role", { role: "Gibt es nicht", task: "x" });
	check("Unbekannte Rolle → Fehler ohne Verbrauch", t.isError && t.text.includes("nicht gefunden"), t.text);

	console.log("8b) Delegation und Zusammenarbeit (bestehende Funktionen)");
	t = await callTool("ki_team_auto_delegate", { task: "Wie bewerbe ich meinen Shop?" });
	remaining -= 2;
	check("ki_team_auto_delegate wählt Rolle und führt aus", !t.isError && t.text.includes("Vorgeschlagene Rollen: Marketing, SEO") && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes(rem()), t.text);

	t = await callTool("ki_team_collaborate", { task: "Login-System bauen", roles: ["Programmierung", "Sicherheit"] });
	remaining -= 3;
	check("ki_team_collaborate parallel + Zusammenfassung", !t.isError && t.text.includes("MOCK-ANTWORT von Programmierung") && t.text.includes("MOCK-ANTWORT von Sicherheit") && t.text.includes("Zusammenfassung (KI-Koordination)") && t.text.includes(rem()), t.text);
	check("Modell-Routing: Programmierung → Code-Modell", t.text.includes(`Modell: ${FREE_CODER} · Profil: code`), t.text);
	check("Modell-Routing: Sicherheit → Reasoning-Modell", t.text.includes(`Modell: ${FREE_R1} · Profil: reasoning`), t.text);

	let orBefore = orRequests.length;
	t = await callTool("ki_team_collaborate", { task: "FAIL_ROLE Kampagne", roles: ["Marketing", "SEO"], mode: "sequential" });
	remaining -= 2; // SEO ist gescheitert -> dieser Aufruf wird zurückerstattet
	check("Gescheiterte Rolle: höchstens 2 OpenRouter-Anfragen (Marketing 1 + SEO 2 + Zusammenfassung 1)", orRequests.length - orBefore === 4, `(${orRequests.length - orBefore})`);
	check("ki_team_collaborate sequenziell, Teilfehler wird gemeldet", !t.isError && t.text.includes("model_unavailable") && t.text.includes("MOCK-ANTWORT von Marketing") && t.text.includes("[mit Kontext]") && t.text.includes(rem()), t.text);

	console.log("8c) Datenschutz vor Weitergabe an externe Modelle");
	t = await callTool("ki_team_run_role", { role: "E-Mails", task: "Mein Passwort: Geheim12345 – schreib eine Mail" });
	check("Zugangsdaten werden blockiert (0 Aufrufe)", t.isError && t.text.includes("Zugangsdaten") && !t.text.includes("Geheim12345") && t.text.includes("nie"), t.text);
	t = await callTool("ki_team_run_role", { role: "E-Mails", task: "Schreibe eine Antwort an max.mustermann@firma.de" });
	check("Personenbezogene Daten → Rückfrage (0 Aufrufe)", t.isError && t.text.includes("Rückfrage nötig") && t.text.includes("E-Mail-Adresse"), t.text);
	t = await callTool("ki_team_run_role", { role: "E-Mails", task: "Schreibe eine Antwort an max.mustermann@firma.de", allow_personal_data: true });
	remaining--;
	check("Mit Zustimmung wird ausgeführt", !t.isError && t.text.includes("MOCK-ANTWORT von E-Mails") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_run_role", { role: "E-Mails", task: "Token ghp_" + "a".repeat(36), allow_personal_data: true });
	check("Zugangsdaten auch mit Zustimmung blockiert", t.isError && t.text.includes("GitHub-Token"), t.text);

	console.log("8d) Qualitätsprüfung + gezielte Nachprüfung");
	t = await callTool("ki_team_run_role", { role: "Projektplanung", task: "Nenne drei Schritte TRUNCATE" });
	remaining -= 2;
	check("Abgeschnittene Antwort wird erkannt", t.text.includes("abgeschnitten") && t.text.includes("Es wurden 3 Punkte verlangt, die Antwort enthält 5"), t.text);
	check("Automatische Nachprüfung bei gravierendem Befund (+1 Aufruf)", t.text.includes("Nachprüfung (Kritische Prüfung)") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_run_role", { role: "Projektplanung", task: "Nenne vier Schritte TRUNCATE", verify: "never" });
	remaining--;
	check("verify=never → keine Nachprüfung", !t.text.includes("Nachprüfung (") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_quality_check", { task: "Nenne drei Ideen", text: "1. A ist gut\n2. B ist gut\n3. C ist gut\n4. D ist gut\n5. E ist gut" });
	check("ki_team_quality_check ohne KI-Aufruf", !t.isError && t.text.includes("3 Punkte verlangt") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_quality_check", { task: "Nenne drei Ideen", text: "I'm sorry, but I cannot help with that." });
	check("Verweigerung wird erkannt", t.text.includes("verweigert") && t.text.includes(rem()), t.text);

	console.log("8e) Projektgedächtnis");
	t = await callTool("ki_team_project_save", { project: "Gartencenter Relaunch", goal: "Neue Website bis Mai", decision: "Farben: Grün/Weiß", status: "Konzeptphase" });
	check("Projekt anlegen + Entscheidung speichern", !t.isError && t.text.includes("angelegt") && t.text.includes("entscheidung gespeichert"), t.text);
	t = await callTool("ki_team_project_save", { project: "gartencenter-relaunch", note: "API_KEY = 'sk-or-v1-" + "ab12".repeat(12) + "'" });
	check("Geheimnisse werden nicht gespeichert", t.isError && t.text.includes("Zugangsdaten"), t.text);
	t = await callTool("ki_team_project_save", { project: "Anderes Projekt", goal: "Etwas ganz anderes" });
	check("Zweites Projekt angelegt", !t.isError && t.text.includes("anderes-projekt"), t.text);
	t = await callTool("ki_team_project_list");
	check("Projektliste", t.text.includes("2 Projekt(e)") && t.text.includes("gartencenter-relaunch") && t.text.includes("anderes-projekt"), t.text);
	t = await callTool("ki_team_run_role", { role: "Marketing", task: "Slogan entwerfen", project: "gartencenter-relaunch" });
	remaining--;
	check("Projektkontext (Ziel + Entscheidung) wird mitgegeben", !t.isError && t.text.includes("[Projektkontext]") && t.text.includes("[Entscheidung bekannt]") && t.text.includes("protokolliert"), t.text);
	t = await callTool("ki_team_run_role", { role: "Marketing", task: "Slogan entwerfen", project: "anderes-projekt" });
	remaining--;
	check("Strikte Trennung: anderes Projekt kennt die Entscheidung nicht", !t.isError && t.text.includes("[Projektkontext]") && !t.text.includes("[Entscheidung bekannt]"), t.text);
	t = await callTool("ki_team_project_get", { project: "gartencenter-relaunch" });
	check("Projekt abrufen: Ziel, Entscheidung, Arbeitsstand", t.text.includes("Neue Website bis Mai") && t.text.includes("[entscheidung] Farben: Grün/Weiß") && t.text.includes("[ergebnis] Marketing") && !t.text.includes("sk-or-v1"), t.text);
	t = await callTool("ki_team_project_get", { project: "gibt-es-nicht" });
	check("Unbekanntes Projekt → Fehler", t.isError, t.text);
	t = await callTool("ki_team_run_role", { role: "Marketing", task: "x", project: "gibt-es-nicht" });
	check("Unbekanntes Projekt beim Auftrag → Fehler ohne Verbrauch", t.isError && t.text.includes("existiert nicht"), t.text);

	console.log("8f) Mehrstufige Teamarbeit");
	t = await callTool("ki_team_pipeline", { task: "Baue einen Newsletter-Anmelder", steps: [{ role: "Recherche" }, { role: "Programmierung", instruction: "Implementiere" }, { role: "Codeprüfung" }], estimate_only: true });
	check("Kostenschätzung ohne Ausführung", t.text.includes("Kontingentbedarf: 3") && t.text.includes("0 KI-Aufrufe"), t.text);
	t = await callTool("ki_team_pipeline", { task: "Baue einen Newsletter-Anmelder", steps: [{ role: "Recherche" }, { role: "Programmierung", instruction: "Implementiere" }, { role: "Codeprüfung" }] });
	remaining -= 3;
	check("Pipeline: 3 Schritte nacheinander mit Übergabe", !t.isError && t.text.includes("Schritt 1: Recherche") && t.text.includes("Schritt 3: Codeprüfung") && /Schritt 2: Programmierung[^#]*\[mit Kontext\]/.test(t.text) && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_pipeline", { task: "Plane TRUNCATE", steps: [{ role: "Projektplanung" }, { role: "Programmierung" }, { role: "Tests" }], verify: "never" });
	remaining -= 1;
	check("Pipeline hält bei gravierendem Problem an und gibt Budget zurück", t.text.includes("angehalten") && !t.text.includes("Schritt 2:") && t.text.includes(rem()), t.text);

	console.log("8g) Code- und Projektprüfung (nur lesend)");
	t = await callTool("ki_team_review_code", { code: "function run(x) {\n  return eval(x);\n}\ndocument.body.innerHTML = x;" });
	remaining -= 2;
	check("Statische Prüfung findet eval + XSS", t.text.includes("Dynamische Codeausführung") && t.text.includes("XSS"), t.text);
	check("KI-Prüfung durch Codeprüfung + Sicherheit mit Code-Profil", t.text.includes("MOCK-ANTWORT von Codeprüfung") && t.text.includes("MOCK-ANTWORT von Sicherheit") && t.text.includes("Profil: code") && t.text.includes(rem()), t.text);
	check("Nur lesend", t.text.includes("Nur lesend"), t.text);
	t = await callTool("ki_team_review_code", { code: "const token = 'ghp_" + "b".repeat(36) + "';" });
	check("Code mit Zugangsdaten: statische Prüfung ja, KI-Prüfung nein", t.text.includes("KI-Prüfung nicht durchgeführt") && !t.text.includes("ghp_bbbb") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_review_code", { repo: "yannikzehnderyz-coder/demo", pr: 7, ai_review: false });
	check("PR von GitHub laden: SQL-Injection + XSS + fehlende Tests", t.text.includes("SQL-Injection") && t.text.includes("src/db.ts") && t.text.includes("keine Testdateien") && t.text.includes(rem()), t.text);
	t = await callTool("ki_team_review_code", { repo: "fremder/repo", pr: 1 });
	check("Nicht freigegebener Besitzer wird abgelehnt", t.isError && t.text.includes("nicht freigegeben"), t.text);

	t = await callTool("ki_team_usage");
	check("ki_team_usage zeigt beide Limits, Cache und Nachprüfungen", !t.isError && t.text.includes(rem()) && /Hauptworker-Limit: \d+\/100 genutzt/.test(t.text) && /Cache beantwortet \(0 Aufrufe\): [1-9]/.test(t.text) && t.text.includes("Nachprüfungen: 1"), t.text);

	console.log("8h) Fehlversuche: Rückerstattung gedeckelt, Anfragen begrenzt");
	let mainBefore = (await callTool("ki_team_usage")).text.match(/Hauptworker-Limit: (\d+)\//)?.[1];
	for (let i = 1; i <= 4; i++) {
		orBefore = orRequests.length;
		t = await callTool("ki_team_run_role", { role: "Marketing", task: "ALLFAIL Versuch" });
		check(`Fehlversuch ${i}: Fehlermeldung, genau 2 OpenRouter-Anfragen, Kontingent zurückerstattet`, t.isError && t.text.includes("model_unavailable") && orRequests.length - orBefore === 2, `(${orRequests.length - orBefore}) ${t.text}`);
	}
	t = await callTool("ki_team_usage");
	check("Nach 5 Fehlschlägen (1 aus Teamarbeit + 4) ist das MCP-Kontingent unverändert", t.text.includes(rem()), t.text);
	check("Rückerstattungen werden gezählt: 5/5", t.text.includes("Zurückerstattete Fehlschläge heute: 5/5"), t.text);
	const mainAfter = t.text.match(/Hauptworker-Limit: (\d+)\//)?.[1];
	check("Hauptworker zählt jeden Fehlversuch trotzdem (harte Obergrenze)", Number(mainAfter) - Number(mainBefore) === 4, `${mainBefore} -> ${mainAfter}`);
	orBefore = orRequests.length;
	t = await callTool("ki_team_run_role", { role: "Marketing", task: "ALLFAIL Versuch" });
	remaining -= 1;
	check("6. Fehlschlag wird NICHT mehr zurückerstattet", t.isError && orRequests.length - orBefore === 2, t.text);
	t = await callTool("ki_team_usage");
	check("Kontingent nach 6. Fehlschlag um 1 gesunken", t.text.includes(rem()), t.text);
	t = await callTool("ki_team_status");
	check("Status zeigt Fehlerprotokoll und pausierte Modelle", t.text.includes("Letzte Fehlschläge:") && t.text.includes("fehler") && t.text.includes("Pausiert"), t.text);

	console.log("9) Atomares Limit bei parallelen Aufrufen");
	const n = remaining + 3;
	const par = await Promise.all(Array.from({ length: n }, (_, i) => callTool("ki_team_run_role", { role: "Recherche", task: `parallel ${i}` })));
	const okCount = par.filter((x) => !x.isError).length;
	check(`Genau ${remaining} von ${n} parallelen Aufrufen erlaubt`, okCount === remaining, `(erlaubt: ${okCount})`);
	remaining = 0;
	t = await callTool("ki_team_run_role", { role: "Recherche", task: "danach" });
	check("Nach Erreichen des Limits → abgelehnt", t.isError && t.text.includes("Tageslimit"), t.text);
	t = await callTool("ki_team_collaborate", { task: "zu teuer", roles: ["Marketing", "SEO", "Recherche"] });
	check("Collaborate wird vorab abgelehnt, wenn Budget nicht reicht", t.isError && t.text.includes("Tageslimit erreicht"), t.text);
	t = await callTool("ki_team_run_role", { role: "marketing", task: "Strategie für Gartencenter" });
	check("Cache funktioniert auch bei ausgeschöpftem Limit", !t.isError && t.text.includes("aus Cache"), t.text);

	console.log("10) Keine Secrets in Antworten");
	check("Keine Secrets in MCP-Ausgaben", !SECRETS.some((s) => allOutput.includes(s)) && !allOutput.includes("Geheim12345") && !allOutput.includes("ghp_aaaa"));

	console.log("11) Hauptworker direkt (Weboberfläche + Schutz der internen API)");
	await stopWrangler();
	const UI = "http://127.0.0.1:8789";
	startWrangler(["-c", "test/main-worker.wrangler.jsonc", "--port", "8789", "--ip", "127.0.0.1", "--var", "DAILY_REQUEST_LIMIT:7", "--persist-to", ".wrangler/ui-state"]);
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
	// Hinweis: HTTP entfernt Leerzeichen am Anfang/Ende eines Headers – daher "!" statt " "
	r = await chat("test-workspace-pw!", "x");
	check("Passwort mit Zusatzzeichen → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("test-workspace-p", "x");
	check("Passwort mit fehlendem Zeichen → 401", r.status === 401, `(war ${r.status})`);
	r = await chat("ÄÖÜ-ß", "x");
	check("Sonderzeichen-Passwort → 401", r.status === 401, `(war ${r.status})`);
	for (const path of ["roles", "usage", "health"]) {
		r = await fetch(`${UI}/api/mcp/v1/${path}`);
		check(`/api/mcp/v1/${path} ohne Passwort → 401`, r.status === 401, `(war ${r.status})`);
	}
	r = await fetch(`${UI}/api/mcp/v1/run`, { method: "POST", headers: { "x-workspace-password": "falsch", "content-type": "application/json" }, body: JSON.stringify({ roleId: "SEO", task: "x" }) });
	check("/api/mcp/v1/run mit falschem Passwort → 401", r.status === 401, `(war ${r.status})`);
	const uiStart = orRequests.length;
	const reqs = async (fn) => { const b4 = orRequests.length; const out = await fn(); return { out, n: orRequests.length - b4, list: orRequests.slice(b4) }; };
	let x = await reqs(() => chat("test-workspace-pw", "Hallo Team"));
	let d = await x.out.json();
	check("/api/chat liefert Antwort (1 Anfrage)", x.out.ok && d.answer?.includes("MOCK-ANTWORT von Marketing") && x.n === 1, JSON.stringify(d));
	check("Fallback-Liste: höchstens 3 Free-Modelle je Anfrage", x.list[0].list.length === 3 && x.list[0].list.every((m) => FREE_SET.includes(m)), JSON.stringify(x.list[0].list));
	x = await reqs(() => chat("test-workspace-pw", "MODEL_DOWN bitte"));
	d = await x.out.json();
	check("Ausfall von Modell 1 → OpenRouter nimmt Modell 2 in derselben Anfrage", x.out.ok && d.model === FREE_B && x.n === 1, JSON.stringify(d));
	x = await reqs(() => chat("test-workspace-pw", "UPSTREAM429 test"));
	d = await x.out.json();
	check("Überlastete Anbieter (429) → nächste Modellgruppe statt Abbruch", x.out.ok && d.model === FREE_R1 && x.n === 2, `${x.n} ${JSON.stringify(d)}`);
	x = await reqs(() => chat("test-workspace-pw", "ALLFAIL test"));
	d = await x.out.json();
	check("Alle Modelle scheitern → Fehler nach genau 2 Anfragen (6 Modelle)", x.out.status === 503 && x.n === 2 && new Set(x.list.flatMap((q) => q.list)).size === 6, `${x.out.status} ${x.n} ${JSON.stringify(d)}`);
	x = await reqs(() => chat("test-workspace-pw", "Gesundheit"));
	d = await x.out.json();
	check("Modell-Gedächtnis: zuletzt erfolgreiches Modell zuerst, mehrfach gescheiterte pausiert", x.out.ok && x.list[0].list[0] === FREE_R1 && ![FREE_A, FREE_B, FREE_CODER].some((m) => x.list[0].list.includes(m)), JSON.stringify(x.list[0].list));
	x = await reqs(() => chat("test-workspace-pw", "EMPTY test"));
	d = await x.out.json();
	check("Leere Antwort gilt als Fehlschlag → nächste Gruppe liefert Text", x.out.ok && x.n === 2 && d.model !== FREE_R1 && d.answer?.includes("MOCK-ANTWORT"), `${x.n} ${JSON.stringify(d)}`);
	x = await reqs(() => chat("test-workspace-pw", "ALLFAIL zwei"));
	check("Erneuter Totalausfall: wieder genau 2 Anfragen", x.out.status === 503 && x.n === 2, `${x.n}`);
	x = await reqs(() => chat("test-workspace-pw", "achte"));
	check("Tageslimit des Hauptworkers greift (429) ohne OpenRouter-Anfrage", x.out.status === 429 && x.n === 0, `${x.out.status} ${x.n}`);
	r = await fetch(`${UI}/api/mcp/v1/usage`, { headers: { "x-workspace-password": "test-workspace-pw" } });
	d = await r.json();
	check("Jeder Auftrag (auch gescheiterte) zählt genau 1× im Tageslimit", d.used === 7 && d.limit === 7 && d.remaining === 0, JSON.stringify(d));
	const uiReqs = orRequests.length - uiStart;
	check(`Obergrenze: ${uiReqs} OpenRouter-Anfragen für 7 Aufträge (max. 2 je Auftrag = 14)`, uiReqs <= 14 && uiReqs === 11, `${uiReqs}`);
	r = await fetch(`${UI}/api/mcp/v1/models`, { headers: { "x-workspace-password": "test-workspace-pw" } });
	const mInfo = await r.json();
	const mText = JSON.stringify(mInfo);
	check("/models: Fehlerprotokoll und Gesundheit ohne Inhalte/Secrets", Array.isArray(mInfo.recent) && mInfo.recent.length > 0 && mInfo.free === 6 && !mText.includes("test-or-key") && !mText.includes("ALLFAIL") && !mText.includes("test-workspace-pw"), mText.slice(0, 400));

	console.log("11b) OpenRouter-Tageslimit: Sperre bis Mitternacht, keine weiteren Anfragen");
	await stopWrangler();
	startWrangler(["-c", "test/main-worker.wrangler.jsonc", "--port", "8789", "--ip", "127.0.0.1", "--var", "DAILY_REQUEST_LIMIT:5", "--persist-to", ".wrangler/block-state"]);
	await waitReady(UI);
	x = await reqs(() => chat("test-workspace-pw", "DAILYLIMIT bitte"));
	d = await x.out.json();
	check("OpenRouter-Tageslimit erkannt → 429 mit klarer Meldung", x.out.status === 429 && /Tageslimit/.test(d.error ?? "") && x.n === 1, `${x.out.status} ${JSON.stringify(d)}`);
	x = await reqs(() => chat("test-workspace-pw", "danach normal"));
	check("Gesperrt: keine weitere OpenRouter-Anfrage", x.out.status === 429 && x.n === 0, `${x.out.status} ${x.n}`);
	x = await reqs(() => fetch(`${UI}/api/mcp/v1/run`, { method: "POST", headers: { "x-workspace-password": "test-workspace-pw", "content-type": "application/json" }, body: JSON.stringify({ roleId: "SEO", task: "auch gesperrt" }) }));
	d = await x.out.json();
	check("Gesperrt auch für MCP-Aufträge (Code openrouter_daily_limit)", x.out.status === 429 && d.error?.code === "openrouter_daily_limit" && x.n === 0, JSON.stringify(d));
	r = await fetch(`${UI}/api/mcp/v1/usage`, { headers: { "x-workspace-password": "test-workspace-pw" } });
	d = await r.json();
	check("Gesperrte Aufträge verbrauchen kein Tageslimit", d.used === 1, JSON.stringify(d));
	r = await fetch(`${UI}/api/mcp/v1/models`, { headers: { "x-workspace-password": "test-workspace-pw" } });
	d = await r.json();
	check("/models meldet Sperre bis Mitternacht UTC", typeof d.blockedUntil === "string" && d.blockedUntil.endsWith("T00:00:00.000Z"), JSON.stringify(d.blockedUntil));

	console.log("12) Kostenschutz");
	check(`Nur :free-Modelle mit Preis 0 in allen ${orRequests.length} Anfragen/Fallback-Listen`, modelCalls.length > 0 && modelCalls.every((m) => FREE_SET.includes(m)), JSON.stringify([...new Set(modelCalls)]));
	check("Kostenpflichtige / falsch markierte / preislose Modelle nie in einer Fallback-Liste", !["paid/expensive", "trap/fake:free", "trap/super-coder:free", "paid/qwen-coder-pro", "trap/nopricing:free"].some((m) => modelCalls.includes(m)));
	const cap = (q) => q.provider?.max_price && ["prompt", "completion", "request", "image"].every((k) => q.provider.max_price[k] === 0);
	check("Jede Anfrage enthält die Preisobergrenze 0 (provider.max_price)", orRequests.length > 0 && orRequests.every(cap), JSON.stringify(orRequests.find((q) => !cap(q))));
	check("Kein Einzelmodell-Feld, jede Fallback-Liste mit 1–3 Modellen", orRequests.every((q) => q.model === undefined && q.list.length >= 1 && q.list.length <= 3));

	await finish(failures.length ? 1 : 0);
} catch (e) {
	console.error("Testabbruch:", e);
	console.error(wrLog.slice(-4000));
	failures.push(`Abbruch: ${e.message}`);
	await finish(1);
}
