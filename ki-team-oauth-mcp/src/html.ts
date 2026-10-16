function esc(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2433;--muted:#5b6475;--accent:#2457d6;--line:#dfe3ea}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--fg:#e8ebf1;--muted:#9aa3b2;--accent:#6d93ff;--line:#2c3340}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:8px 0;color:var(--muted)}strong{color:var(--fg)}
.box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:16px 0}
button{width:100%;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:600;background:var(--accent);color:#fff;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

export function homePage(): string {
	return layout("Privater MCP-Server", `<h1>Privater MCP-Server</h1><p>Dieser Dienst ist nicht öffentlich nutzbar.</p>`);
}

export function errorPage(message: string): string {
	return layout("Anmeldung nicht möglich", `<h1>Anmeldung nicht möglich</h1><p>${esc(message)}</p>`);
}

export function consentPage(o: { clientName: string; redirectHost: string; requestId: string; csrf: string }): string {
	return layout(
		"KI-Team verbinden",
		`<h1>KI-Team mit Claude verbinden?</h1>
<p>Die Anwendung <strong>${esc(o.clientName)}</strong> möchte auf dein privates KI-Team zugreifen.</p>
<div class="box"><p>Antwort wird gesendet an: <strong>${esc(o.redirectHost)}</strong></p>
<p>Im nächsten Schritt meldest du dich bei GitHub an. Nur dein freigegebener Account erhält Zugriff.</p></div>
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${esc(o.requestId)}">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<button type="submit">Mit GitHub anmelden und freigeben</button>
</form>`,
	);
}
