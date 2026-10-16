// NUR FÜR TESTS: implementiert die interne API /api/mcp/v1 wie im README beschrieben.
const NAMES = [
	"Projektplanung", "Recherche", "Programmierung", "Fehlersuche", "Codeprüfung", "Tests",
	"Dokumentation", "Übersetzung", "Zusammenfassung", "Ideenfindung", "Mathematik", "Datenanalyse",
	"Sicherheit", "UX-Design", "UI-Texte", "Produktstrategie", "Marketing", "SEO", "E-Mails",
	"Rechtliche Informationen", "Finanzinformationen", "Lernhilfe", "Prompt-Optimierung",
	"Qualitätskontrolle", "Kritische Prüfung", "KI-Koordination",
];
const slug = (s) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/[^a-z0-9]+/g, "-");
const ROLES = NAMES.map((name) => ({ id: slug(name), name, description: `Testbeschreibung ${name}` }));
let calls = 0;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.headers.get("x-workspace-password") !== env.WORKSPACE_PASSWORD) {
			return Response.json({ error: { code: "unauthorized", message: "Passwort falsch" } }, { status: 401 });
		}
		switch (url.pathname) {
			case "/api/mcp/v1/health":
				return Response.json({ ok: true, roles: ROLES.length, version: "mock" });
			case "/api/mcp/v1/roles":
				return Response.json({ roles: ROLES });
			case "/api/mcp/v1/usage":
				return Response.json({ used: calls, limit: 20, remaining: 20 - calls });
			case "/api/mcp/v1/run": {
				if (request.method !== "POST") return new Response("method", { status: 405 });
				const { roleId, task, context } = await request.json();
				const role = ROLES.find((r) => r.id === roleId);
				if (!role) return Response.json({ error: { code: "unknown_role", message: "Rolle unbekannt" } }, { status: 400 });
				calls++;
				if (task.includes("FAIL_ROLE") && roleId === "seo") {
					return Response.json({ error: { code: "model_unavailable", message: "Free-Modell nicht verfügbar" } }, { status: 503 });
				}
				let output = `MOCK-ANTWORT von ${role.name}: ${task.slice(0, 40)}${context ? ` [mit Kontext ${context.length} Zeichen]` : ""}`;
				if (roleId === "ki-koordination" && task.includes("AUSSCHLIESSLICH mit JSON")) {
					output = 'Hier: {"roles":["marketing","seo","gibtsnicht"],"reason":"Marketingthema"}';
				}
				return Response.json({ roleId, roleName: role.name, output, model: "mock/free-model:free", usage: { used: calls, limit: 20, remaining: 20 - calls } });
			}
		}
		return new Response("not found", { status: 404 });
	},
};
