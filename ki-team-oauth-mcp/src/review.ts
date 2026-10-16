/**
 * Projektprüfung für Code (nur lesend – es wird nie etwas geändert, gepusht oder veröffentlicht).
 *
 * 1. Statische Prüfung ohne KI-Aufruf: typische Sicherheits- und Qualitätsprobleme.
 * 2. Optional: KI-Prüfung durch Rollen wie "Codeprüfung", "Sicherheit", "Tests".
 *
 * Quelle: eingefügter Code oder öffentlich lesbarer Pull Request / Datei auf GitHub
 * (nur freigegebene Besitzer, ohne Token, max. Größe begrenzt).
 */

export interface StaticFinding {
	severity: "hoch" | "mittel" | "niedrig" | "info";
	rule: string;
	text: string;
	line?: number;
	file?: string;
}

const RULES: { severity: StaticFinding["severity"]; rule: string; text: string; re: RegExp }[] = [
	{ severity: "hoch", rule: "eval", text: "Dynamische Codeausführung (eval/new Function)", re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
	{ severity: "hoch", rule: "shell", text: "Shell-Befehl mit zusammengesetzten Werten (Command Injection)", re: /\b(exec|execSync|spawn)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+)|subprocess\.\w+\([^)]*shell\s*=\s*True|os\.system\s*\(/ },
	{ severity: "hoch", rule: "sql", text: "SQL aus Zeichenketten zusammengesetzt (SQL-Injection)", re: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(["'`]\s*\+\s*\w|\$\{[^}]+\})/i },
	{ severity: "hoch", rule: "tls", text: "TLS-Prüfung deaktiviert", re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=?\s*["']?0/ },
	{ severity: "hoch", rule: "deserialize", text: "Unsichere Deserialisierung", re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)/ },
	{ severity: "mittel", rule: "xss", text: "HTML wird ungefiltert eingefügt (XSS-Risiko)", re: /\.(innerHTML|outerHTML)\s*\+?=(?!=)|dangerouslySetInnerHTML|document\.write\s*\(/ },
	{ severity: "mittel", rule: "random", text: "Math.random für sicherheitsrelevante Werte", re: /Math\.random\(\)[^\n]{0,60}(token|secret|passw|key|session|id\b)|(token|secret|passw|key|session)[^\n]{0,60}Math\.random\(\)/i },
	{ severity: "mittel", rule: "weak-hash", text: "Schwacher Hash (MD5/SHA-1)", re: /\b(md5|sha1)\b\s*\(|createHash\(\s*["'](md5|sha1)["']/i },
	{ severity: "mittel", rule: "log-secret", text: "Mögliche Ausgabe von Geheimnissen im Log", re: /console\.(log|info|debug)\([^)]*(password|passwort|secret|token|apikey|api_key)/i },
	{ severity: "mittel", rule: "compare", text: "Geheimnis-Vergleich nicht zeitkonstant", re: /(password|passwort|secret|token|apikey)[\w.]*\s*(===|!==|==|!=)\s*[\w.]*(password|passwort|secret|token|key)/i },
	{ severity: "niedrig", rule: "cors", text: "CORS für alle Ursprünge geöffnet", re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/i },
	{ severity: "niedrig", rule: "http", text: "Unverschlüsselte http-URL", re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^"'`\s]+/ },
	{ severity: "info", rule: "todo", text: "Offener TODO/FIXME", re: /\b(TODO|FIXME|XXX)\b/ },
];

/** Prüft Quelltext bzw. Diffs zeilenweise. Bei Diffs werden nur hinzugefügte Zeilen bewertet. */
export function staticReview(source: string, isDiff = false): StaticFinding[] {
	const findings: StaticFinding[] = [];
	let file: string | undefined;
	let lineNo = 0;
	for (const raw of source.split("\n")) {
		lineNo++;
		const fileHeader = raw.match(/^### Datei: (.+)$/) || raw.match(/^\+\+\+ b\/(.+)$/);
		if (fileHeader) {
			file = fileHeader[1].trim();
			continue;
		}
		if (isDiff && !raw.startsWith("+")) continue;
		const line = isDiff ? raw.slice(1) : raw;
		for (const r of RULES) {
			if (r.re.test(line)) findings.push({ severity: r.severity, rule: r.rule, text: r.text, line: lineNo, file });
		}
	}
	// Doppelte Regeltreffer je Datei zusammenfassen (max. 3 pro Regel)
	const perRule = new Map<string, number>();
	return findings.filter((f) => {
		const k = `${f.file ?? ""}:${f.rule}`;
		const n = (perRule.get(k) ?? 0) + 1;
		perRule.set(k, n);
		return n <= 3;
	});
}

export function formatStatic(findings: StaticFinding[]): string {
	if (!findings.length) return "Statische Prüfung: keine Auffälligkeiten gefunden (heuristisch, kein Ersatz für ein Review).";
	const order = { hoch: 0, mittel: 1, niedrig: 2, info: 3 };
	const lines = [...findings]
		.sort((a, b) => order[a.severity] - order[b.severity])
		.map((f) => `- [${f.severity}] ${f.text}${f.file ? ` – ${f.file}` : ""}${f.line ? ` (Zeile ${f.line})` : ""}`);
	return `Statische Prüfung (${findings.length} Hinweise):\n${lines.join("\n")}`;
}

export interface FetchedSource {
	text: string;
	isDiff: boolean;
	label: string;
	files: string[];
	truncated: boolean;
}

export class ReviewSourceError extends Error {}

/** Lädt einen öffentlichen PR-Diff oder eine Datei von GitHub (ohne Token, nur erlaubte Besitzer). */
export async function fetchGithubSource(
	env: Env,
	opts: { repo: string; pr?: number; path?: string; ref?: string },
	maxChars: number,
): Promise<FetchedSource> {
	const m = opts.repo.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
	if (!m) throw new ReviewSourceError("Repository bitte im Format 'besitzer/name' angeben.");
	const owner = m[1];
	const allowed = String(env.ALLOWED_REVIEW_OWNERS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!allowed.includes(owner.toLowerCase())) {
		throw new ReviewSourceError(`Besitzer '${owner}' ist nicht freigegeben (erlaubt: ${allowed.join(", ") || "keiner"}).`);
	}
	const api = env.GITHUB_API_BASE || "https://api.github.com";
	const headers = { "User-Agent": "ki-team-oauth-mcp", Accept: "application/vnd.github+json" };

	if (opts.pr) {
		const res = await fetch(`${api}/repos/${opts.repo}/pulls/${opts.pr}/files?per_page=100`, { headers });
		if (res.status === 404) throw new ReviewSourceError("Pull Request nicht gefunden oder Repository nicht öffentlich.");
		if (res.status === 403 || res.status === 429) throw new ReviewSourceError("GitHub-Abruflimit ohne Anmeldung erreicht. Bitte später erneut oder Code direkt einfügen.");
		if (!res.ok) throw new ReviewSourceError(`GitHub antwortet mit HTTP ${res.status}.`);
		const files = (await res.json()) as { filename: string; status: string; patch?: string }[];
		let text = "";
		let truncated = false;
		const names: string[] = [];
		for (const f of files) {
			names.push(f.filename);
			const block = `### Datei: ${f.filename} (${f.status})\n${f.patch ?? "(kein Textdiff, z. B. Binärdatei oder zu groß)"}\n\n`;
			if (text.length + block.length > maxChars) {
				truncated = true;
				break;
			}
			text += block;
		}
		return { text, isDiff: true, label: `${opts.repo} PR #${opts.pr}`, files: names, truncated };
	}

	if (opts.path) {
		const path = opts.path.replace(/^\/+/, "");
		if (path.includes("..")) throw new ReviewSourceError("Ungültiger Pfad.");
		const url = `${api}/repos/${opts.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : ""}`;
		const res = await fetch(url, { headers: { ...headers, Accept: "application/vnd.github.raw" } });
		if (res.status === 404) throw new ReviewSourceError("Datei nicht gefunden oder Repository nicht öffentlich.");
		if (res.status === 403 || res.status === 429) throw new ReviewSourceError("GitHub-Abruflimit ohne Anmeldung erreicht. Bitte später erneut oder Code direkt einfügen.");
		if (!res.ok) throw new ReviewSourceError(`GitHub antwortet mit HTTP ${res.status}.`);
		const body = await res.text();
		return {
			text: `### Datei: ${path}\n${body.slice(0, maxChars)}`,
			isDiff: false,
			label: `${opts.repo}/${path}${opts.ref ? `@${opts.ref}` : ""}`,
			files: [path],
			truncated: body.length > maxChars,
		};
	}
	throw new ReviewSourceError("Bitte entweder 'pr' (Nummer) oder 'path' (Dateipfad) angeben.");
}

export function isTestFile(name: string): boolean {
	return /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|^test_.*\.py$/i.test(name);
}
