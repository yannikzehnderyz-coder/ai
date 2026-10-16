# Hauptworker `claude-ki-team`

Versionierte Kopie des Worker-Codes (ohne Secrets). Wird im Cloudflare-Dashboard unter
„Code bearbeiten“ eingefügt; die Bereitstellung erfolgt dort, nicht automatisch aus GitHub.

Version 2 ergänzt die interne API `/api/mcp/v1/*` für den MCP-Server `ki-team-oauth-mcp`.
Weboberfläche, `/api/chat`, Passwort, Tageslimit und die 26 Rollen bleiben unverändert.

## Sicherung

`backup/worker-v1-original-2026-10-16.js` – unveränderter Originalcode (Version 1), wie er am
16.10.2026 produktiv lief. Zum Zurücksetzen: Inhalt im Dashboard unter „Code bearbeiten“ einfügen
und bereitstellen. Enthält keine Secrets (diese liegen nur in Cloudflare).

## Version 3

Modell-Routing nach Aufgabenprofil (`code`, `reasoning`, `writing`, `fast`, `long`), weiterhin nur
kostenlose `:free`-Modelle mit Preis 0, Fallback auf weitere Free-Modelle, `finish_reason` in der
Antwort und Endpunkt `/api/mcp/v1/models`. Weboberfläche und `/api/chat` bleiben kompatibel.
Rückweg: `backup/worker-v1-original-2026-10-16.js` oder die v2-Version aus der Git-Historie.

## Bereitstellung über GitHub (Workers Builds)

Statt im Dashboard-Editor kann der Worker aus diesem Ordner gebaut werden:
Worker `claude-ki-team` → Einstellungen → Build → mit `yannikzehnderyz-coder/ai` verbinden,
Branch `main`, Root-Verzeichnis `claude-ki-team`, Build-Befehl leer, Deploy-Befehl `npx wrangler deploy`.
`wrangler.jsonc` übernimmt nur `LIMITS_KV`; Secrets bleiben erhalten, Dashboard-Variablen dank `keep_vars`.
