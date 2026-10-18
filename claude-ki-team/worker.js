// =====================================================================
// Hauptworker "claude-ki-team" – Version 3.1
// Komplett ins Cloudflare-Dashboard ("Code bearbeiten") einfügen.
//
// Unverändert: Weboberfläche, POST /api/chat, Passwort (APP_PASSWORD),
//              Tageslimit (LIMITS_KV, DAILY_REQUEST_LIMIT), 26 Rollen.
// Neu:         interne API /api/mcp/v1/* für den MCP-Server (gleiches Passwort),
//              strengere Free-Modell-Prüfung, Fallback auf ein 2. Free-Modell,
//              Fehler von OpenRouter werden als Fehler gemeldet (nicht als Antwort),
//              zeitkonstanter Passwortvergleich, Modellliste wird 1 h zwischengespeichert.
// Neu in v3:   Modell-Routing nach Aufgabenprofil (code / reasoning / writing / fast / long),
//              weiterhin AUSSCHLIESSLICH ":free"-Modelle mit Preis 0; Fallback auf andere Free-Modelle,
//              kurzzeitiges Überspringen gerade ausgefallener Modelle, finish_reason in der Antwort,
//              Endpunkt /api/mcp/v1/models (zeigt nur kostenlose Modelle, kein KI-Aufruf).
// Neu in 3.1:  Zuverlässigeres Routing: OpenRouter probiert pro Anfrage bis zu 3 Free-Modelle selbst
//              (Fallback-Liste "models"), höchstens 2 Anfragen pro Auftrag. Preisobergrenze 0 bei
//              OpenRouter (provider.max_price). Überlastete Anbieter (429) führen zum nächsten Modell,
//              nur das echte OpenRouter-Tageslimit stoppt – dann bis Mitternacht (UTC) Sperre ohne
//              weitere Anfragen. Dauerhaftes Modell-Gedächtnis (Erfolge/Fehlschläge) im KV-Speicher,
//              leere Antworten gelten als Fehlschlag, Fehlerprotokoll ohne Inhalte.
//
// Secrets/Variablen (bestehend): OPENROUTER_API_KEY, APP_PASSWORD, DAILY_REQUEST_LIMIT, LIMITS_KV
// Optional: MAX_TOKENS (Standard 1000), PREFERRED_MODELS (kommagetrennte :free-Modell-IDs)
// =====================================================================

const rollen = ["Projektplanung","Recherche","Programmierung","Fehlersuche","Codeprüfung","Tests","Dokumentation","Übersetzung","Zusammenfassung","Ideenfindung","Mathematik","Datenanalyse","Sicherheit","UX-Design","UI-Texte","Produktstrategie","Marketing","SEO","E-Mails","Rechtliche Informationen","Finanzinformationen","Lernhilfe","Prompt-Optimierung","Qualitätskontrolle","Kritische Prüfung","KI-Koordination"];

const VERSION = "3.1.0";
// Obergrenzen pro Auftrag: höchstens MAX_REQUESTS Anfragen an OpenRouter, jede mit höchstens
// MODELS_PER_REQUEST kostenlosen Modellen, die OpenRouter der Reihe nach selbst probiert.
const MODELS_PER_REQUEST = 3;
const MAX_REQUESTS = 2;
const MODEL_CACHE_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000; // Modelle mit >= 2 Fehlschlägen in Folge kommen 30 min ans Ende
const ROUTING_KEY = "routing:v1";   // Modell-Gedächtnis + Fehlerprotokoll (keine Inhalte, keine Secrets)
const BLOCK_KEY = "openrouter:blocked-until";
const MAX_RECENT = 20;
// Harte Preisobergrenze bei OpenRouter: Anfragen werden nur von Anbietern mit Preis 0 bedient.
const FREE_PRICE_CAP = { prompt: 0, completion: 0, request: 0, image: 0 };
let modelCache = { at: 0, models: [] };

// ---- Modell-Routing: welches Profil passt zu welcher Rolle ----
const PROFILES = ["code", "reasoning", "writing", "fast", "long"];
const ROLE_PROFILE = {
  "Programmierung": "code", "Fehlersuche": "code", "Codeprüfung": "code", "Tests": "code",
  "Mathematik": "reasoning", "Datenanalyse": "reasoning", "Kritische Prüfung": "reasoning",
  "Qualitätskontrolle": "reasoning", "Sicherheit": "reasoning", "Finanzinformationen": "reasoning",
  "Rechtliche Informationen": "reasoning",
};
const PROFILE_MATCH = {
  code: /coder|codestral|devstral|starcoder|codellama|code-/i,
  reasoning: /(^|[/:-])r1([:-]|$)|reason|think|qwq|magistral|deepseek-r/i,
  writing: /llama|mistral|gemma|qwen|hermes|nemo|glm|kimi|command|gpt-oss/i,
  fast: /(^|[-_/ ])(1b|1\.5b|2b|3b|4b|7b|8b|9b|mini|small|nano|flash|lite)([-_: ]|$)/i,
};

class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function orBase(env) {
  // OPENROUTER_BASE nur für automatisierte Tests; in Produktion NICHT setzen.
  return env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
}

async function passwordOk(request, env) {
  const given = request.headers.get("x-workspace-password") || "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.APP_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function dailyLimit(env) {
  return Math.max(1, Number(env.DAILY_REQUEST_LIMIT) || 20);
}

function limitKey() {
  return "requests:" + new Date().toISOString().slice(0, 10);
}

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

async function usage(env) {
  const limit = dailyLimit(env);
  const used = Number((await env.LIMITS_KV.get(limitKey())) || 0);
  return { used, limit, remaining: Math.max(0, limit - used), resetsAt: nextUtcMidnight() };
}

// Hinweis: KV ist nicht atomar. Bei gleichzeitigen Anfragen kann der Zähler
// leicht zu niedrig sein. Das kostet nichts (nur Free-Modelle); der MCP-Server
// hat zusätzlich ein atomares Limit, und OpenRouter begrenzt Free-Modelle selbst.
async function countRequest(env) {
  const u = await usage(env);
  if (u.used >= u.limit) throw new AppError(429, "daily_limit", "Tageslimit erreicht. Morgen geht es weiter.");
  await env.LIMITS_KV.put(limitKey(), String(u.used + 1), { expirationTtl: 172800 });
  return { ...u, used: u.used + 1, remaining: Math.max(0, u.remaining - 1) };
}

function isFree(m) {
  if (!m || typeof m.id !== "string" || !m.id.endsWith(":free")) return false;
  const p = m.pricing;
  // Preise müssen ausdrücklich angegeben sein, und ALLE angegebenen Preisfelder müssen 0 sein
  if (!p || typeof p !== "object" || p.prompt === undefined || p.completion === undefined) return false;
  return Object.values(p).every((v) => v === undefined || v === null || Number(v) === 0);
}

async function freeModels(env) {
  if (Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length) return modelCache.models;
  let data;
  try {
    data = await fetch(orBase(env) + "/models").then((r) => r.json());
  } catch {
    throw new AppError(502, "models_unavailable", "Modellliste von OpenRouter nicht abrufbar.");
  }
  let models = (data.data || []).filter(isFree).map((m) => ({ id: m.id, ctx: Number(m.context_length) || 0 }));
  const preferred = String(env.PREFERRED_MODELS || "").split(",").map((s) => s.trim());
  models = [
    ...preferred.map((id) => models.find((m) => m.id === id)).filter(Boolean),
    ...models.filter((m) => !preferred.includes(m.id)),
  ];
  if (!models.length) throw new AppError(503, "no_free_model", "Kein kostenloses Modell verfügbar.");
  modelCache = { at: Date.now(), models };
  return models;
}

// Reihenfolge der Kandidaten für ein Profil: passende Modelle zuerst, dann alle übrigen Free-Modelle.
// Gerade ausgefallene Modelle wandern ans Ende. Es kommen nie andere als freie Modelle in Frage.
function primaryFor(list, profile) {
  if (profile === "long") return [...list].sort((a, b) => b.ctx - a.ctx).slice(0, 3);
  if (profile === "writing") {
    return list.filter((m) => PROFILE_MATCH.writing.test(m.id) && !PROFILE_MATCH.code.test(m.id) && !PROFILE_MATCH.reasoning.test(m.id));
  }
  return PROFILE_MATCH[profile] ? list.filter((m) => PROFILE_MATCH[profile].test(m.id)) : [];
}

// ---- Modell-Gedächtnis (dauerhaft im vorhandenen KV, 1 Schreibvorgang pro Auftrag) ----
async function loadRouting(env) {
  try {
    const r = await env.LIMITS_KV.get(ROUTING_KEY, "json");
    if (r && typeof r === "object") return { health: r.health && typeof r.health === "object" ? r.health : {}, recent: Array.isArray(r.recent) ? r.recent : [] };
  } catch { /* leer starten */ }
  return { health: {}, recent: [] };
}

async function saveRouting(env, st) {
  // nur Modelle behalten, die zuletzt (14 Tage) aktiv waren – hält den Eintrag klein
  const cutoff = Date.now() - 14 * 86400000;
  for (const [id, h] of Object.entries(st.health)) if (Math.max(h.lastOk || 0, h.lastFail || 0) < cutoff) delete st.health[id];
  st.recent = st.recent.slice(-MAX_RECENT);
  try { await env.LIMITS_KV.put(ROUTING_KEY, JSON.stringify(st), { expirationTtl: 30 * 86400 }); } catch { /* nicht kritisch */ }
}

function markOk(st, id) {
  const h = st.health[id] || (st.health[id] = { ok: 0, fail: 0, streak: 0 });
  h.ok = Math.min(1000, (h.ok || 0) + 1); h.streak = 0; h.lastOk = Date.now();
}

function markFail(st, id, kind) {
  const h = st.health[id] || (st.health[id] = { ok: 0, fail: 0, streak: 0 });
  h.fail = Math.min(1000, (h.fail || 0) + 1); h.streak = (h.streak || 0) + 1; h.lastFail = Date.now(); h.lastKind = kind;
}

function inCooldown(h, now) {
  return !!h && (h.streak || 0) >= 2 && now - (h.lastFail || 0) < COOLDOWN_MS;
}

function healthScore(h, now) {
  if (!h) return 0;
  const recentOk = h.lastOk && now - h.lastOk < 86400000 ? 2 : 0;
  return recentOk + Math.min(h.ok || 0, 10) * 0.2 - Math.min(h.fail || 0, 10) * 0.2 - (h.streak || 0) * 0.5;
}

// Reihenfolge: passende Modelle des Profils zuerst, darin zuverlässige vor unbekannten vor
// fehleranfälligen; Modelle in der Abkühlphase ganz ans Ende. Es kommen nur freie Modelle vor.
function orderModels(models, profile, inputChars, health = {}) {
  const needCtx = Math.ceil(inputChars / 3) + 2000;
  let list = models.filter((m) => !m.ctx || m.ctx >= needCtx);
  if (!list.length) list = models;
  const now = Date.now();
  const primary = new Set(primaryFor(list, profile).map((m) => m.id));
  const rank = (m) => [inCooldown(health[m.id], now) ? 1 : 0, primary.has(m.id) ? 0 : 1, -healthScore(health[m.id], now)];
  return list
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.i - b.i)
    .map((x) => x.m.id);
}

function secondsUntilUtcMidnight() {
  const d = new Date(); const m = new Date(d); m.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((m - d) / 1000));
}

async function blockedUntil(env) {
  try { return await env.LIMITS_KV.get(BLOCK_KEY); } catch { return null; }
}

async function assertNotBlocked(env) {
  const until = await blockedUntil(env);
  if (until) throw new AppError(429, "openrouter_daily_limit", "Das kostenlose OpenRouter-Tageslimit ist erreicht. Bis " + until + " (UTC) werden keine Anfragen mehr gesendet.");
}

function chooseProfile(role, requested, inputChars) {
  if (PROFILES.includes(requested)) return requested;
  if (inputChars > 24000) return "long";
  return ROLE_PROFILE[role] || "writing";
}

async function runRole(env, role, task, context, requestedProfile) {
  await assertNotBlocked(env);
  const all = await freeModels(env);
  const freeIds = new Set(all.map((m) => m.id));
  const userContent = context ? task + "\n\n---\nKontext:\n" + context : task;
  const profile = chooseProfile(role, requestedProfile, userContent.length);
  const st = await loadRouting(env);
  const order = orderModels(all, profile, userContent.length, st.health);
  // Harte Sicherung: nur Modelle aus der geprüften Free-Liste mit ":free"
  const safe = order.filter((id) => id.endsWith(":free") && freeIds.has(id));
  const batches = [];
  for (let i = 0; i < MAX_REQUESTS; i++) {
    const b = safe.slice(i * MODELS_PER_REQUEST, (i + 1) * MODELS_PER_REQUEST);
    if (b.length) batches.push(b);
  }
  if (!batches.length) throw new AppError(503, "no_free_model", "Kein kostenloses Modell verfügbar.");
  const baseTokens = Math.min(4000, Math.max(100, Number(env.MAX_TOKENS) || 1000));
  const maxTokens = profile === "reasoning" || profile === "code" ? Math.min(4000, baseTokens * 2) : baseTokens;
  const log = (kind, models, status) => st.recent.push({ t: new Date().toISOString(), profile, kind, status, models });

  let lastErr = null;
  try {
    for (const batch of batches) {
      let r, data;
      try {
        r = await fetch(orBase(env) + "/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            models: batch, // OpenRouter probiert diese Free-Modelle der Reihe nach (eine Anfrage)
            provider: { max_price: FREE_PRICE_CAP }, // nur Anbieter mit Preis 0
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: "Du bist ein KI-Spezialist für " + role + ". Antworte knapp auf Deutsch." },
              { role: "user", content: userContent },
            ],
          }),
        });
        data = await r.json().catch(() => ({}));
      } catch {
        lastErr = new AppError(502, "openrouter_unreachable", "OpenRouter nicht erreichbar.");
        log("netzwerk", batch, 0);
        continue;
      }
      const choice = data && data.choices && data.choices[0];
      const answer = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content.trim() : "";
      const served = data && typeof data.model === "string" ? data.model : batch[0];
      if (r.ok && answer) {
        if (!batch.includes(served) && !served.endsWith(":free")) log("unerwartetes_modell", [served], r.status);
        markOk(st, batch.includes(served) ? served : batch[0]);
        return { output: answer, model: served, profile, finishReason: choice.finish_reason || undefined, attempts: batches.indexOf(batch) + 1 };
      }
      if (r.ok) {
        // 200, aber leer (z. B. Denk-Modell hat das Budget fürs Nachdenken verbraucht)
        markFail(st, batch.includes(served) ? served : batch[0], "leer");
        log("leer", [served], 200);
        lastErr = new AppError(503, "empty_answer", "Das Free-Modell " + served + " hat eine leere Antwort geliefert.");
        continue;
      }
      const err = (data && data.error) || {};
      const msg = String(err.message || "HTTP " + r.status).slice(0, 200);
      const meta = err.metadata || {};
      if (r.status === 429) {
        const upstream = !!(meta.provider_name || meta.provider_code || meta.raw);
        const platform = !upstream && (r.headers.has("x-ratelimit-limit") || /rate limit exceeded/i.test(msg));
        if (platform && /per[-_ ]?day/i.test(msg)) {
          const until = (() => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); })();
          try { await env.LIMITS_KV.put(BLOCK_KEY, until, { expirationTtl: secondsUntilUtcMidnight() }); } catch { /* egal */ }
          log("tageslimit_openrouter", batch, 429);
          throw new AppError(429, "openrouter_daily_limit", "Das kostenlose OpenRouter-Tageslimit ist erreicht. Bis " + until + " (UTC) werden keine Anfragen mehr gesendet.");
        }
        if (platform) {
          log("minutenlimit_openrouter", batch, 429);
          throw new AppError(429, "openrouter_rate_limit", "OpenRouter-Minutenlimit für Free-Modelle erreicht. Bitte kurz warten.");
        }
        for (const id of batch) markFail(st, id, "überlastet");
        log("überlastet", batch, 429);
        lastErr = new AppError(503, "model_unavailable", "Die kostenlosen Modelle sind gerade überlastet (" + batch.join(", ") + ").");
        continue;
      }
      if (r.status === 401 || r.status === 402) {
        log("zugang", batch, r.status);
        throw new AppError(502, "openrouter_auth", "OpenRouter lehnt die Anfrage ab (" + r.status + "): " + msg);
      }
      for (const id of batch) markFail(st, id, "fehler_" + r.status);
      log("fehler", batch, r.status);
      lastErr = new AppError(503, "model_unavailable", "Free-Modelle nicht verfügbar (" + batch.join(", ") + "): " + msg);
    }
  } finally {
    await saveRouting(env, st);
  }
  throw lastErr || new AppError(503, "model_unavailable", "Kein Free-Modell hat geantwortet.");
}

const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function handleMcpApi(request, env, path) {
  const fail = (e) => json({ error: { code: e.code || "internal", message: e.message || "Interner Fehler" } }, e.status || 500);
  try {
    if (path === "/api/mcp/v1/health" && request.method === "GET") {
      return json({ ok: true, roles: rollen.length, version: VERSION });
    }
    if (path === "/api/mcp/v1/roles" && request.method === "GET") {
      return json({ roles: rollen.map((name) => ({ id: name, name })) });
    }
    if (path === "/api/mcp/v1/usage" && request.method === "GET") {
      return json(await usage(env));
    }
    if (path === "/api/mcp/v1/models" && request.method === "GET") {
      const models = await freeModels(env);
      const profiles = {};
      for (const p of PROFILES) {
        profiles[p] = primaryFor(models, p).slice(0, 5).map((m) => m.id);
      }
      const st = await loadRouting(env);
      const now = Date.now();
      const reliable = Object.entries(st.health)
        .filter(([id, h]) => h.lastOk && now - h.lastOk < 86400000 && !inCooldown(h, now) && models.some((m) => m.id === id))
        .sort((a, b) => healthScore(b[1], now) - healthScore(a[1], now))
        .slice(0, 5)
        .map(([id]) => id);
      const cooling = Object.entries(st.health).filter(([, h]) => inCooldown(h, now)).map(([id]) => id);
      return json({ free: models.length, profiles, version: VERSION, reliable, cooling, recent: st.recent.slice(-10), blockedUntil: await blockedUntil(env), limits: { modelsPerRequest: MODELS_PER_REQUEST, maxRequests: MAX_REQUESTS } });
    }
    if (path === "/api/mcp/v1/run" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const role = rollen.find((r) => r === body.roleId);
      if (!role) throw new AppError(400, "unknown_role", "Unbekannte Rolle.");
      const task = String(body.task || "").slice(0, 8000);
      const context = body.context ? String(body.context).slice(0, 12000) : "";
      if (!task.trim()) throw new AppError(400, "empty_task", "Bitte Aufgabe angeben.");
      const profile = body.profile === undefined || body.profile === null ? undefined : String(body.profile);
      if (profile !== undefined && !PROFILES.includes(profile)) throw new AppError(400, "bad_profile", "Unbekanntes Modellprofil.");
      await assertNotBlocked(env);
      const u = await countRequest(env);
      const res = await runRole(env, role, task, context, profile);
      return json({ roleId: role, roleName: role, output: res.output, model: res.model, profile: res.profile, finishReason: res.finishReason, usage: u });
    }
    throw new AppError(404, "not_found", "Unbekannter Endpunkt.");
  } catch (e) {
    return fail(e);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isMcpApi = url.pathname.startsWith("/api/mcp/v1/");

    if ((request.method === "POST" && url.pathname === "/api/chat") || isMcpApi) {
      if (!env.OPENROUTER_API_KEY || !env.APP_PASSWORD) return json({ error: "Zugangsdaten noch nicht eingerichtet" }, 503);
      if (!env.LIMITS_KV) return json({ error: "KV-Speicher nicht verbunden" }, 503);
      if (!(await passwordOk(request, env))) {
        return isMcpApi
          ? json({ error: { code: "unauthorized", message: "Falsches Passwort" } }, 401)
          : json({ error: "Falsches Passwort" }, 401);
      }
      if (isMcpApi) return handleMcpApi(request, env, url.pathname);

      // ---- Weboberfläche: POST /api/chat (Verhalten wie bisher) ----
      try {
        const body = await request.json().catch(() => ({}));
        const task = String(body.task || "").slice(0, 4000);
        const role = rollen.includes(body.role) ? body.role : rollen[0];
        if (!task.trim()) return json({ error: "Bitte Aufgabe eingeben" }, 400);
        await assertNotBlocked(env);
        await countRequest(env);
        const res = await runRole(env, role, task);
        return json({ answer: res.output, model: res.model });
      } catch (e) {
        return json({ error: e.message || "Fehler" }, e.status || 500);
      }
    }

    const options = rollen.map(r=>'<option>'+r+'</option>').join("");
    return new Response(`<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Mein KI-Team</title><style>body{font:17px system-ui;background:#101827;color:white;padding:20px;max-width:700px;margin:auto}input,select,textarea,button{box-sizing:border-box;width:100%;padding:13px;margin:9px 0;border-radius:9px;font:inherit}button{background:#5486ef;color:white;border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Mein KI-Team · 26 Agenten</h1><p>Cloud Workspace für iPad und PC</p><input id="pw" type="password" placeholder="Workspace-Passwort"><select id="role">${options}</select><textarea id="task" rows="6" placeholder="Deine Aufgabe"></textarea><button id="go">KI starten</button><pre id="out"></pre><script>document.getElementById("go").onclick=async()=>{const out=document.getElementById("out");out.textContent="Bitte warten ...";try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json","x-workspace-password":document.getElementById("pw").value},body:JSON.stringify({role:document.getElementById("role").value,task:document.getElementById("task").value})});const d=await r.json();out.textContent=d.answer||d.error||"Fehler"}catch(e){out.textContent=e.message}};</script></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
  }
};
