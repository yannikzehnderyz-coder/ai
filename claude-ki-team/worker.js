// =====================================================================
// Hauptworker "claude-ki-team" – Version 2
// Komplett ins Cloudflare-Dashboard ("Code bearbeiten") einfügen.
//
// Unverändert: Weboberfläche, POST /api/chat, Passwort (APP_PASSWORD),
//              Tageslimit (LIMITS_KV, DAILY_REQUEST_LIMIT), 26 Rollen.
// Neu:         interne API /api/mcp/v1/* für den MCP-Server (gleiches Passwort),
//              strengere Free-Modell-Prüfung, Fallback auf ein 2. Free-Modell,
//              Fehler von OpenRouter werden als Fehler gemeldet (nicht als Antwort),
//              zeitkonstanter Passwortvergleich, Modellliste wird 1 h zwischengespeichert.
//
// Secrets/Variablen (bestehend): OPENROUTER_API_KEY, APP_PASSWORD, DAILY_REQUEST_LIMIT, LIMITS_KV
// Optional: MAX_TOKENS (Standard 1000), PREFERRED_MODELS (kommagetrennte :free-Modell-IDs)
// =====================================================================

const rollen = ["Projektplanung","Recherche","Programmierung","Fehlersuche","Codeprüfung","Tests","Dokumentation","Übersetzung","Zusammenfassung","Ideenfindung","Mathematik","Datenanalyse","Sicherheit","UX-Design","UI-Texte","Produktstrategie","Marketing","SEO","E-Mails","Rechtliche Informationen","Finanzinformationen","Lernhilfe","Prompt-Optimierung","Qualitätskontrolle","Kritische Prüfung","KI-Koordination"];

const VERSION = "2.0.0";
const MAX_MODEL_ATTEMPTS = 2; // höchstens 2 Free-Modelle pro Anfrage probieren
const MODEL_CACHE_MS = 60 * 60 * 1000;
let modelCache = { at: 0, ids: [] };

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
  const p = m.pricing || {};
  // Alle angegebenen Preisfelder müssen 0 sein
  return Object.values(p).every((v) => v === undefined || v === null || Number(v) === 0);
}

async function freeModels(env) {
  if (Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.ids.length) return modelCache.ids;
  let data;
  try {
    data = await fetch(orBase(env) + "/models").then((r) => r.json());
  } catch {
    throw new AppError(502, "models_unavailable", "Modellliste von OpenRouter nicht abrufbar.");
  }
  let ids = (data.data || []).filter(isFree).map((m) => m.id);
  const preferred = String(env.PREFERRED_MODELS || "").split(",").map((s) => s.trim()).filter((s) => ids.includes(s));
  ids = [...preferred, ...ids.filter((id) => !preferred.includes(id))];
  if (!ids.length) throw new AppError(503, "no_free_model", "Kein kostenloses Modell verfügbar.");
  modelCache = { at: Date.now(), ids };
  return ids;
}

async function runRole(env, role, task, context) {
  const models = await freeModels(env);
  const userContent = context ? task + "\n\n---\nKontext:\n" + context : task;
  let lastErr = null;
  for (const model of models.slice(0, MAX_MODEL_ATTEMPTS)) {
    // Harte Sicherung: niemals ein Modell ohne ":free" aufrufen
    if (!model.endsWith(":free")) continue;
    let r, data;
    try {
      r = await fetch(orBase(env) + "/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: Math.min(4000, Math.max(100, Number(env.MAX_TOKENS) || 1000)),
          messages: [
            { role: "system", content: "Du bist ein KI-Spezialist für " + role + ". Antworte knapp auf Deutsch." },
            { role: "user", content: userContent },
          ],
        }),
      });
      data = await r.json().catch(() => ({}));
    } catch {
      lastErr = new AppError(502, "openrouter_unreachable", "OpenRouter nicht erreichbar.");
      continue;
    }
    const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (r.ok && answer) return { output: answer, model };
    const msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
    if (r.status === 429) {
      // Free-Kontingent bei OpenRouter erschöpft – weitere Versuche wären sinnlos
      throw new AppError(429, "openrouter_rate_limit", "OpenRouter-Free-Limit erreicht: " + msg);
    }
    if (r.status === 401 || r.status === 402 || r.status === 403) {
      throw new AppError(502, "openrouter_auth", "OpenRouter lehnt die Anfrage ab (" + r.status + "): " + msg);
    }
    lastErr = new AppError(503, "model_unavailable", "Free-Modell " + model + " nicht verfügbar: " + msg);
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
    if (path === "/api/mcp/v1/run" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const role = rollen.find((r) => r === body.roleId);
      if (!role) throw new AppError(400, "unknown_role", "Unbekannte Rolle.");
      const task = String(body.task || "").slice(0, 8000);
      const context = body.context ? String(body.context).slice(0, 12000) : "";
      if (!task.trim()) throw new AppError(400, "empty_task", "Bitte Aufgabe angeben.");
      const u = await countRequest(env);
      const res = await runRole(env, role, task, context);
      return json({ roleId: role, roleName: role, output: res.output, model: res.model, usage: u });
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
