const rollen = ["Projektplanung","Recherche","Programmierung","Fehlersuche","Codeprüfung","Tests","Dokumentation","Übersetzung","Zusammenfassung","Ideenfindung","Mathematik","Datenanalyse","Sicherheit","UX-Design","UI-Texte","Produktstrategie","Marketing","SEO","E-Mails","Rechtliche Informationen","Finanzinformationen","Lernhilfe","Prompt-Optimierung","Qualitätskontrolle","Kritische Prüfung","KI-Koordination"];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (!env.OPENROUTER_API_KEY || !env.APP_PASSWORD) return Response.json({error:"Zugangsdaten noch nicht eingerichtet"},{status:503});
      if (request.headers.get("x-workspace-password") !== env.APP_PASSWORD) return Response.json({error:"Falsches Passwort"},{status:401});
      const limit = Math.max(1, Number(env.DAILY_REQUEST_LIMIT) || 20);
const today = new Date().toISOString().slice(0, 10);
const limitKey = "requests:" + today;

if (!env.LIMITS_KV) {
  return Response.json(
    { error: "KV-Speicher nicht verbunden" },
    { status: 503 }
  );
}

const used = Number(await env.LIMITS_KV.get(limitKey) || 0);

if (used >= limit) {
  return Response.json(
    { error: "Tageslimit erreicht. Morgen geht es weiter." },
    { status: 429 }
  );
}const body = await request.json().catch(()=>({}));
      const task = String(body.task||"").slice(0,4000);
      const role = rollen.includes(body.role) ? body.role : rollen[0];
      if (!task.trim()) return Response.json({error:"Bitte Aufgabe eingeben"},{status:400});
      const models = await fetch("https://openrouter.ai/api/v1/models").then(r=>r.json());
      const free = (models.data||[]).filter(m=>m.id.endsWith(":free") && Number(m.pricing?.prompt||0)===0 && Number(m.pricing?.completion||0)===0);
      if (!free.length) return Response.json({error:"Kein kostenloses Modell verfügbar"},{status:503});
      await env.LIMITS_KV.put(
  limitKey,
  String(used + 1),
  { expirationTtl: 172800 }
);const r = await fetch("https://openrouter.ai/api/v1/chat/completions",{
        method:"POST",
        headers:{"Authorization":"Bearer "+env.OPENROUTER_API_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({model:free[0].id,max_tokens:400,messages:[{role:"system",content:"Du bist ein KI-Spezialist für "+role+". Antworte knapp auf Deutsch."},{role:"user",content:task}]})
      });
      const data = await r.json();
      return Response.json({answer:data.choices?.[0]?.message?.content||data.error?.message||"Keine Antwort"});
    }
    const options = rollen.map(r=>'<option>'+r+'</option>').join("");
    return new Response(`<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Mein KI-Team</title><style>body{font:17px system-ui;background:#101827;color:white;padding:20px;max-width:700px;margin:auto}input,select,textarea,button{box-sizing:border-box;width:100%;padding:13px;margin:9px 0;border-radius:9px;font:inherit}button{background:#5486ef;color:white;border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Mein KI-Team · 26 Agenten</h1><p>Cloud Workspace für iPad und PC</p><input id="pw" type="password" placeholder="Workspace-Passwort"><select id="role">${options}</select><textarea id="task" rows="6" placeholder="Deine Aufgabe"></textarea><button id="go">KI starten</button><pre id="out"></pre><script>document.getElementById("go").onclick=async()=>{const out=document.getElementById("out");out.textContent="Bitte warten ...";try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json","x-workspace-password":document.getElementById("pw").value},body:JSON.stringify({role:document.getElementById("role").value,task:document.getElementById("task").value})});const d=await r.json();out.textContent=d.answer||d.error||"Fehler"}catch(e){out.textContent=e.message}};</script></html>`,{headers:{"content-type":"text/html; charset=utf-8"}});
  }
};
