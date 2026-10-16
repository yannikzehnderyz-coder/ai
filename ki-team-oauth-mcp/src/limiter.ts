import { DurableObject } from "cloudflare:workers";

/**
 * Atomarer Nutzungszähler (ein einziges Durable Object für alles).
 *
 * Warum kein KV? KV ist "eventually consistent": Zwei parallele Anfragen können
 * beide den alten Zählerstand lesen und so das Tageslimit überschreiten.
 * Ein Durable Object verarbeitet Aufrufe nacheinander, und die SQL-API ist
 * synchron – dadurch ist "prüfen + hochzählen" garantiert atomar.
 *
 * Free-Tarif: SQLite-Durable-Objects sind im Workers-Free-Plan enthalten.
 * Bei Überschreiten der Free-Grenzen schlagen Operationen fehl (es entstehen
 * keine Kosten) – der Limiter "fail-closed": Fehler => kein KI-Aufruf.
 */

export type Bucket = "ai" | "register" | "cache_hit" | "verify";

export interface ReserveResult {
	ok: boolean;
	reason?: "daily" | "minute";
	usedToday: number;
	dailyLimit: number;
	remainingToday: number;
	resetsAt: string;
}

function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now: number): string {
	const d = new Date(now);
	d.setUTCHours(24, 0, 0, 0);
	return d.toISOString();
}

export class UsageLimiter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS daily (bucket TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (bucket, day))",
		);
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS events (bucket TEXT NOT NULL, ts INTEGER NOT NULL)",
		);
		// Ergebnis-Cache: identische Anfragen innerhalb der TTL verbrauchen keinen KI-Aufruf
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)",
		);
	}

	async cacheGet(key: string): Promise<string | null> {
		const now = Date.now();
		const row = this.ctx.storage.sql
			.exec<{ value: string; expires: number }>("SELECT value, expires FROM cache WHERE key = ?", key)
			.toArray()[0];
		if (!row || Number(row.expires) < now) return null;
		const day = utcDay(now);
		this.ctx.storage.sql.exec(
			"INSERT INTO daily (bucket, day, used) VALUES ('cache_hit', ?, 1) ON CONFLICT(bucket, day) DO UPDATE SET used = used + 1",
			day,
		);
		return String(row.value);
	}

	async cachePut(key: string, value: string, ttlMs: number, maxRows = 300): Promise<void> {
		const now = Date.now();
		this.ctx.storage.sql.exec("DELETE FROM cache WHERE expires < ?", now);
		this.ctx.storage.sql.exec(
			"INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires",
			key,
			value.slice(0, 60_000),
			now + ttlMs,
		);
		// Nur zwischengespeicherte KI-Antworten (keine Nutzerdaten) – älteste zuerst verdrängen
		this.ctx.storage.sql.exec(
			"DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY expires ASC LIMIT MAX(0, (SELECT COUNT(*) FROM cache) - ?))",
			maxRows,
		);
	}

	async counter(bucket: Bucket): Promise<number> {
		return this.usedToday(bucket, utcDay(Date.now()));
	}

	private usedToday(bucket: Bucket, day: string): number {
		const rows = this.ctx.storage.sql
			.exec<{ used: number }>("SELECT used FROM daily WHERE bucket = ? AND day = ?", bucket, day)
			.toArray();
		return rows.length ? Number(rows[0].used) : 0;
	}

	/**
	 * Reserviert `units` Einheiten. Entweder alle oder keine (keine halben Läufe).
	 */
	async reserve(
		bucket: Bucket,
		units: number,
		dailyLimit: number,
		perMinuteLimit: number,
	): Promise<ReserveResult> {
		const now = Date.now();
		const day = utcDay(now);
		const n = Math.max(1, Math.floor(units));

		// Aufräumen: alte Tage und Minuten-Ereignisse entfernen
		this.ctx.storage.sql.exec("DELETE FROM daily WHERE day < ?", day);
		this.ctx.storage.sql.exec("DELETE FROM events WHERE ts < ?", now - 60_000);

		const used = this.usedToday(bucket, day);
		const base = { usedToday: used, dailyLimit, resetsAt: nextUtcMidnight(now) };

		if (used + n > dailyLimit) {
			return { ok: false, reason: "daily", remainingToday: Math.max(0, dailyLimit - used), ...base };
		}

		if (perMinuteLimit > 0) {
			const recent = this.ctx.storage.sql
				.exec<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE bucket = ?", bucket)
				.toArray()[0];
			if (Number(recent?.c ?? 0) + n > perMinuteLimit) {
				return { ok: false, reason: "minute", remainingToday: dailyLimit - used, ...base };
			}
		}

		this.ctx.storage.sql.exec(
			"INSERT INTO daily (bucket, day, used) VALUES (?, ?, ?) ON CONFLICT(bucket, day) DO UPDATE SET used = used + excluded.used",
			bucket,
			day,
			n,
		);
		for (let i = 0; i < n; i++) {
			this.ctx.storage.sql.exec("INSERT INTO events (bucket, ts) VALUES (?, ?)", bucket, now);
		}

		const usedAfter = used + n;
		return {
			ok: true,
			usedToday: usedAfter,
			dailyLimit,
			remainingToday: dailyLimit - usedAfter,
			resetsAt: base.resetsAt,
		};
	}

	/**
	 * Gibt reservierte, aber nicht genutzte Einheiten zurück (z. B. wenn ein
	 * Zusammenarbeits-Lauf vorzeitig abbricht, bevor weitere KI-Aufrufe erfolgten).
	 */
	async release(bucket: Bucket, units: number): Promise<void> {
		const day = utcDay(Date.now());
		const n = Math.max(0, Math.floor(units));
		if (!n) return;
		this.ctx.storage.sql.exec(
			"UPDATE daily SET used = MAX(0, used - ?) WHERE bucket = ? AND day = ?",
			n,
			bucket,
			day,
		);
	}

	async status(bucket: Bucket, dailyLimit: number): Promise<Omit<ReserveResult, "ok" | "reason">> {
		const now = Date.now();
		const used = this.usedToday(bucket, utcDay(now));
		return {
			usedToday: used,
			dailyLimit,
			remainingToday: Math.max(0, dailyLimit - used),
			resetsAt: nextUtcMidnight(now),
		};
	}
}

export function limiterStub(env: Env) {
	return env.USAGE_LIMITER.get(env.USAGE_LIMITER.idFromName("global"));
}

export function intVar(value: string | undefined, fallback: number, min = 0, max = 10_000): number {
	const n = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
