/**
 * Erkennung sensibler Inhalte, bevor Text an externe KI-Modelle geht oder im
 * Projektgedächtnis gespeichert wird. Läuft lokal, ohne KI-Aufruf.
 *
 *  - credentials: Zugangsdaten (API-Schlüssel, Tokens, private Schlüssel, Passwörter).
 *                 Werden IMMER blockiert – auch mit Zustimmung (gehören nie in Prompts/Speicher).
 *  - personal:    personenbezogene/finanzielle Daten (E-Mail, Telefon, IBAN, Kartennummer).
 *                 Nur mit ausdrücklicher Zustimmung (allow_personal_data = true).
 *
 * Es werden nur die ART und eine maskierte Andeutung gemeldet, nie der Wert selbst.
 */

export interface SensitiveFinding {
	kind: "credential" | "personal";
	label: string;
}

const CREDENTIAL_PATTERNS: { label: string; re: RegExp }[] = [
	{ label: "privater Schlüssel", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ label: "GitHub-Token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
	{ label: "OpenRouter-/OpenAI-/Anthropic-Schlüssel", re: /\bsk-(or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
	{ label: "AWS-Zugangsschlüssel", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ label: "Google-API-Schlüssel", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ label: "Slack-Token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	{ label: "Stripe-Schlüssel", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
	{ label: "JWT/Bearer-Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
	{ label: "Bearer-Token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
];

// "passwort: geheim123", "api_key = 'abc...'", "token=xyz..."
const ASSIGNMENT_RE =
	/\b(pass(?:wor[dt])?|kennwort|pwd|secret|geheimnis|token|api[_-]?key|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*(["'`]?)([^\s"'`,;]{6,})/gi;
const PLACEHOLDER_RE = /^(x+|\*+|\.+|-+|<[^>]*>|\$\{?[A-Z_]+\}?|env\.[A-Za-z_]+|process\.env\.[A-Za-z_]+|changeme|example|beispiel|dein[_-]?\w*|your[_-]?\w*|test[_-]?\w*|dummy\w*|placeholder|null|undefined|true|false)$/i;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+|00)\d{1,3}[\s/-]?\(?\d{2,5}\)?[\s/-]?\d{3,}[\s/-]?\d{0,6}|\b0\d{2,5}[\s/-]\d{4,}(?:[\s/-]\d{1,6})?\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function ibanValid(raw: string): boolean {
	const s = raw.replace(/\s+/g, "");
	if (s.length < 15 || s.length > 34) return false;
	const rearranged = s.slice(4) + s.slice(0, 4);
	let rem = 0;
	for (const ch of rearranged) {
		const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
		for (const d of v) rem = (rem * 10 + Number(d)) % 97;
	}
	return rem === 1;
}

function luhnValid(raw: string): boolean {
	const digits = raw.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	if (/^(\d)\1+$/.test(digits)) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let n = Number(digits[i]);
		if (alt) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		alt = !alt;
	}
	return sum % 10 === 0;
}

/** Bekannte, unkritische Adressen (z. B. Beispiel-Domains) werden ignoriert. */
function isHarmlessEmail(e: string): boolean {
	return /@(example\.(com|org|net)|beispiel\.de|test\.(de|com)|localhost)$/i.test(e) || /noreply|no-reply/i.test(e);
}

export function scanSensitive(text: string): SensitiveFinding[] {
	if (!text) return [];
	const found = new Map<string, SensitiveFinding>();
	const add = (kind: SensitiveFinding["kind"], label: string) => found.set(`${kind}:${label}`, { kind, label });

	for (const p of CREDENTIAL_PATTERNS) if (p.re.test(text)) add("credential", p.label);
	for (const m of text.matchAll(ASSIGNMENT_RE)) {
		const quoted = m[2] !== "";
		const value = m[3].replace(/[)\]}]+$/, "");
		if (PLACEHOLDER_RE.test(value)) continue;
		// Code wie `password = req.body.password` oder `token: getToken()` ist kein Geheimnis
		const looksLikeExpression = /[.()[\]]/.test(value) || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !/\d/.test(value));
		const looksLikeSecret = quoted ? !/^[A-Za-z_]+$/.test(value) || value.length >= 12 : !looksLikeExpression && /\d/.test(value) && /[A-Za-z]/.test(value);
		if (looksLikeSecret) add("credential", `${m[1].toLowerCase()} als Klartext`);
	}
	for (const m of text.matchAll(EMAIL_RE)) if (!isHarmlessEmail(m[0])) add("personal", "E-Mail-Adresse");
	for (const m of text.matchAll(PHONE_RE)) if (m[0].replace(/\D/g, "").length >= 8) add("personal", "Telefonnummer");
	for (const m of text.matchAll(IBAN_RE)) if (ibanValid(m[0])) add("personal", "IBAN");
	for (const m of text.matchAll(CARD_RE)) if (luhnValid(m[0])) add("personal", "Kartennummer");
	return [...found.values()];
}

export interface SensitiveDecision {
	ok: boolean;
	message?: string;
	findings: SensitiveFinding[];
}

/**
 * Entscheidet, ob Text weitergegeben/gespeichert werden darf.
 * @param target Beschreibung des Ziels für die Meldung (z. B. "an externe KI-Modelle")
 */
export function checkSensitive(texts: (string | undefined)[], allowPersonal: boolean, target: string): SensitiveDecision {
	const findings = scanSensitive(texts.filter(Boolean).join("\n\n"));
	const creds = findings.filter((f) => f.kind === "credential");
	const personal = findings.filter((f) => f.kind === "personal");
	if (creds.length) {
		return {
			ok: false,
			findings,
			message: `Gestoppt: Der Text enthält vermutlich Zugangsdaten (${creds.map((c) => c.label).join(", ")}). Solche Daten werden nie ${target} gegeben. Bitte entfernen oder durch Platzhalter wie XXX ersetzen.`,
		};
	}
	if (personal.length && !allowPersonal) {
		return {
			ok: false,
			findings,
			message: `Rückfrage nötig: Der Text enthält personenbezogene Daten (${personal.map((p) => p.label).join(", ")}). Sie werden nur ${target} gegeben, wenn der Nutzer ausdrücklich zustimmt – dann erneut mit allow_personal_data=true aufrufen. Es wurde kein KI-Aufruf verbraucht.`,
		};
	}
	return { ok: true, findings };
}
