/**
 * Automatische Qualitätsprüfung OHNE KI-Aufruf (reine Heuristiken).
 * Erkennt typische Probleme kostenloser Modelle: leere oder abgeschnittene Antworten,
 * Verweigerungen, falsche Sprache, falsche Anzahl gewünschter Punkte, Platzhalter,
 * Endlosschleifen, offene Codeblöcke – und mögliche Widersprüche zwischen Teammitgliedern.
 *
 * Bewusst konservativ: Heuristiken liefern Hinweise, keine Beweise.
 */

export interface QualityIssue {
	level: "fehler" | "warnung";
	code: string;
	text: string;
}

export interface QualityReport {
	score: number;
	issues: QualityIssue[];
	severe: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
	zwei: 2, drei: 3, vier: 4, "fünf": 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
	two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const COUNT_NOUNS =
	"schritte?|punkte?|tipps?|ideen?|vorschläge?|gründe?|beispiele?|fragen|optionen|maßnahmen|massnahmen|varianten|namen|slogans?|titel|überschriften|argumente?|vorteile?|nachteile?|risiken|aufgaben|thesen|stichpunkte?|steps|points|tips|ideas|reasons|examples";
const COUNT_RE = new RegExp(
	`\\b(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:[\\wäöüß-]+\\s+){0,2}(${COUNT_NOUNS})\\b`,
	"i",
);

const GERMAN_WORDS = /\b(und|der|die|das|ist|nicht|mit|für|ein|eine|ich|wie|auf|zu|den|von|bitte|erstelle|nenne|schreibe)\b/gi;
const ENGLISH_WORDS = /\b(the|and|is|are|with|for|this|that|you|your|of|to|in|it)\b/gi;

function count(re: RegExp, s: string): number {
	return (s.match(re) ?? []).length;
}

function requestedCount(task: string): number | undefined {
	const m = task.match(COUNT_RE);
	if (!m) return undefined;
	const raw = m[1].toLowerCase();
	const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
	return n && n >= 2 && n <= 30 ? n : undefined;
}

function topLevelListItems(output: string): number {
	let inCode = false;
	let n = 0;
	for (const line of output.split("\n")) {
		if (/^\s*```/.test(line)) {
			inCode = !inCode;
			continue;
		}
		if (inCode) continue;
		if (/^(?:[-*•]|\d{1,2}[.)])\s+\S/.test(line)) n++;
	}
	return n;
}

export function assessQuality(task: string, output: string, finishReason?: string): QualityReport {
	const issues: QualityIssue[] = [];
	const text = (output ?? "").trim();
	const add = (level: QualityIssue["level"], code: string, t: string) => issues.push({ level, code, text: t });

	if (text.length < 20) add("fehler", "leer", "Antwort ist leer oder extrem kurz.");

	if (/\b(ich kann (dir |ihnen )?(dabei |damit )?nicht helfen|als (eine? )?ki(-sprachmodell)? (kann|darf) ich nicht|i can(?:not|'t) (help|assist)|as an ai( language model)?|i'?m sorry,? but i)/i.test(text)) {
		add("fehler", "verweigert", "Das Modell hat die Aufgabe (teilweise) verweigert.");
	}

	if (finishReason === "length") {
		add("fehler", "abgeschnitten", "Antwort wurde wegen der Längenbegrenzung abgeschnitten.");
	} else if (text.length > 300 && !/[.!?)"'»*:|`>\]]\s*$/.test(text) && !/```\s*$/.test(text)) {
		add("warnung", "evtl_abgeschnitten", "Antwort endet mitten im Satz – möglicherweise unvollständig.");
	}

	if (count(/^\s*```/gm, text) % 2 === 1) add("warnung", "codeblock", "Ein Codeblock ist nicht geschlossen.");

	const de = count(GERMAN_WORDS, task);
	const en = count(ENGLISH_WORDS, task);
	if (de > en && text.length > 80) {
		const outDe = count(GERMAN_WORDS, text);
		const outEn = count(ENGLISH_WORDS, text);
		if (outEn > outDe * 2 && outEn >= 8) add("warnung", "sprache", "Antwort ist überwiegend Englisch statt Deutsch.");
	}

	const wanted = requestedCount(task);
	if (wanted) {
		const items = topLevelListItems(text);
		if (items > 0 && items !== wanted) {
			add("warnung", "anzahl", `Es wurden ${wanted} Punkte verlangt, die Antwort enthält ${items}.`);
		}
	}

	if (/\b(TODO|FIXME|lorem ipsum)\b|\[(?:platzhalter|hier einfügen|insert[^\]]*)\]/i.test(text)) {
		add("warnung", "platzhalter", "Antwort enthält Platzhalter (TODO/Lorem ipsum/[…]).");
	}

	const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 15);
	const seen = new Map<string, number>();
	for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
	if ([...seen.values()].some((c) => c >= 3)) add("warnung", "wiederholung", "Antwort wiederholt dieselben Zeilen mehrfach.");

	const fehler = issues.filter((i) => i.level === "fehler").length;
	const warn = issues.length - fehler;
	return { score: Math.max(0, 100 - fehler * 40 - warn * 10), issues, severe: fehler > 0 };
}

/** Grobe Erkennung gegensätzlicher Empfehlungen zwischen Teammitgliedern. */
export function detectContradictions(items: { name: string; text: string }[]): string[] {
	const NEG = /\b(nicht (zu )?empfehlen|nicht empfehlenswert|rate (ich )?(davon )?ab|abzuraten|abraten|nicht sinnvoll|lohnt sich nicht|keine gute idee|empfehle (ich )?nicht)\b/i;
	const POS = /\b(empfehle|empfehlenswert|ist sinnvoll|lohnt sich|gute idee|klare empfehlung)\b/i;
	const pro: string[] = [];
	const contra: string[] = [];
	for (const it of items) {
		const neg = NEG.test(it.text);
		const pos = POS.test(it.text.replace(new RegExp(NEG.source, "gi"), ""));
		if (neg && !pos) contra.push(it.name);
		else if (pos && !neg) pro.push(it.name);
	}
	return pro.length && contra.length
		? [`Mögliche gegensätzliche Empfehlungen: eher dafür ${pro.join(", ")} – eher dagegen ${contra.join(", ")}.`]
		: [];
}

export function formatQuality(r: QualityReport): string {
	if (!r.issues.length) return `Qualitätsprüfung: ✅ keine Auffälligkeiten (${r.score}/100)`;
	const icon = r.severe ? "❌" : "⚠️";
	return `Qualitätsprüfung: ${icon} ${r.score}/100 – ${r.issues.map((i) => i.text).join(" ")}`;
}
