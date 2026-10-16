# Hauptworker `claude-ki-team`

Versionierte Kopie des Worker-Codes (ohne Secrets). Wird im Cloudflare-Dashboard unter
„Code bearbeiten“ eingefügt; die Bereitstellung erfolgt dort, nicht automatisch aus GitHub.

Version 2 ergänzt die interne API `/api/mcp/v1/*` für den MCP-Server `ki-team-oauth-mcp`.
Weboberfläche, `/api/chat`, Passwort, Tageslimit und die 26 Rollen bleiben unverändert.

## Sicherung

`backup/worker-v1-original-2026-10-16.js` – unveränderter Originalcode (Version 1), wie er am
16.10.2026 produktiv lief. Zum Zurücksetzen: Inhalt im Dashboard unter „Code bearbeiten“ einfügen
und bereitstellen. Enthält keine Secrets (diese liegen nur in Cloudflare).
