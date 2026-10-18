# KI-Team OAuth-MCP-Server

Privater Remote-MCP-Server, über den Claude (Pro) dein bestehendes KI-Team im Worker
`claude-ki-team` steuert. Läuft komplett im Cloudflare-Workers-Free-Tarif.

```
Claude ──OAuth 2.1 (Code + PKCE S256)──▶ ki-team-oauth-mcp ──GitHub-Login (nur deine ID)
                                            │
                                            ├─ atomarer Tageszähler (SQLite-Durable-Object)
                                            ▼  Service-Binding KI_TEAM (nicht öffentlich)
                                         claude-ki-team ──▶ OpenRouter (:free-Modelle)
```

Dieser Ordner ist bewusst **eigenständig** (eigene `package.json`, liegt außerhalb der
pnpm-Workspace-Pfade des Monorepos). Die Vorlage `demos/remote-mcp-server` bleibt unverändert.

## Sicherheit

| Thema | Umsetzung |
|---|---|
| Anmeldung | GitHub-OAuth; nur GitHub-Benutzer-ID `340084289` (`yannikzehnderyz-coder`) erhält Tokens. Demo-Login (`isLoggedIn = true`, `if (false)`) existiert hier nicht. |
| Warum nicht Cloudflare Access | Zero Trust verlangt auch im Free-Tarif die Hinterlegung von Zahlungsdaten. |
| Redirect-URIs | Nur `https://claude.ai/api/mcp/auth_callback` – bei Registrierung **und** bei `/authorize` geprüft. |
| PKCE | `S256` Pflicht, `plain` und fehlendes PKCE werden abgelehnt. |
| CSRF / State | OAuth-Anfrage bleibt serverseitig (KV, 10 min), Formular enthält nur Zufalls-ID + CSRF-Token (Double-Submit-Cookie). GitHub-`state` ist einmalig und an den Browser gebunden. |
| Tokens | Ausgabe/Prüfung/Refresh-Rotation durch `@cloudflare/workers-oauth-provider` (Tokens nur gehasht in KV). GitHub-Token wird nach dem Login verworfen. |
| Tools | Jeder Tool-Aufruf prüft zusätzlich die GitHub-ID im Token. |
| Registrierung | `/register` nur für Claude-Redirect und gedrosselt (max. 30/Tag) – schützt die KV-Free-Grenze. |
| Hauptworker | Nur über Service-Binding erreichbar; dessen Passwortprüfung bleibt aktiv (Secret `KI_TEAM_PASSWORD`). |
| Secrets | Ausschließlich als Cloudflare-Secrets, nie im Repo. |

## Kostenkontrolle

* Eigenes **atomares** Tageslimit (`MCP_DAILY_LIMIT`, Standard 20, UTC-Tag) und Burst-Limit
  (`MCP_PER_MINUTE_LIMIT`, Standard 6/min) in einem SQLite-Durable-Object – parallele Aufrufe
  können das Limit nicht überschreiten (im Test nachgewiesen).
* Mehrschritt-Tools reservieren ihr komplettes Budget **vorab** (alles oder nichts); nicht
  genutzte Einheiten werden bei Abbruch zurückgegeben.
* Das Limit des Hauptworkers bleibt zusätzlich bestehen.
* Bei Überschreitung der Cloudflare-Free-Grenzen schlagen Aufrufe fehl – es entstehen keine Kosten.

## MCP-Tools (v3)

| Tool | KI-Aufrufe |
|---|---|
| `ki_team_status` (inkl. kostenlose Modelle und Routing) | 0 |
| `ki_team_list_roles` (live aus dem Hauptworker) | 0 |
| `ki_team_run_role` (Rolle per ID oder Name) | 1 (0 bei Cache-Treffer) |
| `ki_team_auto_delegate` (Auswahl durch „KI-Koordination“, optional Ausführung) | 1–2 |
| `ki_team_collaborate` (2–4 Rollen, parallel oder sequenziell, optional Zusammenfassung) | 2–5 |
| `ki_team_usage` (inkl. Cache-Ersparnis und Nachprüfungen) | 0 |
| `ki_team_pipeline` – mehrstufige Teamarbeit mit geprüfter Übergabe, stoppt bei gravierenden Problemen | 2–5 |
| `ki_team_quality_check` – Qualitätsprüfung eines Textes; `deep=true` mit Nachprüfung | 0 (1) |
| `ki_team_project_list` / `_get` / `_save` – Projektgedächtnis | 0 |
| `ki_team_review_code` – statische + KI-Prüfung von Code, PRs oder Dateien (nur lesend) | 0–3 |

### Neu in v3

* **Qualitätsprüfung ohne KI-Aufruf:** leere/abgeschnittene Antworten, Verweigerung, falsche Sprache,
  falsche Anzahl, Platzhalter, Wiederholungen, offene Codeblöcke, gegensätzliche Empfehlungen im Team.
  Gezielte Nachprüfung durch „Kritische Prüfung“ nur bei gravierenden Befunden (`verify=auto`)
  und nur, wenn mehr als `QUALITY_RESERVE` Aufrufe frei sind.
* **Projektgedächtnis:** SQLite-Durable-Object pro GitHub-Konto, Projekte strikt getrennt,
  nichts wird gelöscht (nur archiviert), Zugangsdaten werden abgewiesen.
* **Zuverlässigeres Routing (3.1):** OpenRouter probiert pro Anfrage bis zu 3 Free-Modelle selbst
  (Fallback-Liste), höchstens 2 Anfragen pro Auftrag; Preisobergrenze 0 direkt bei OpenRouter
  (`provider.max_price`); überlastete Anbieter → nächste Gruppe, echtes OpenRouter-Tageslimit → Sperre
  bis Mitternacht UTC ohne weitere Anfragen; dauerhaftes Modell-Gedächtnis; leere Antworten = Fehlschlag;
  Fehlschläge werden bis zu 5×/Tag dem MCP-Kontingent zurückerstattet (Hauptworker zählt sie weiter).
* **Modell-Routing** (Hauptworker v3): Profile `code`, `reasoning`, `writing`, `fast`, `long`
  nach Rolle oder explizit; ausschließlich `:free`-Modelle mit Preis 0, Fallback auf weitere Free-Modelle.
* **Kontingentmanager:** Cache für identische Anfragen (0 Aufrufe), Vorab-Reservierung mit Rückgabe,
  `estimate_only` zur Kostenschätzung, bestehende Tages- und Minutenlimits unverändert.
* **Datenschutz:** Zugangsdaten werden nie an externe Modelle gegeben; personenbezogene Daten
  (E-Mail, Telefon, IBAN, Kartennummer) nur mit `allow_personal_data=true` nach Zustimmung.
* **Code-Prüfung:** nur lesend; GitHub-Quellen nur von `ALLOWED_REVIEW_OWNERS`, ohne Token.

## Interne API, die der Hauptworker bereitstellen muss (v1)

Alle Anfragen kommen über das Service-Binding und tragen `x-workspace-password`.

| Methode & Pfad | Antwort |
|---|---|
| `GET /api/mcp/v1/health` | `{ "ok": true, "roles": 26, "version": "…" }` |
| `GET /api/mcp/v1/roles` | `{ "roles": [{ "id", "name", "description" }] }` |
| `POST /api/mcp/v1/run` `{ roleId, task, context?, profile? }` | `{ roleId, roleName, output, model, profile?, finishReason?, usage? }` |
| `GET /api/mcp/v1/usage` | `{ used, limit, remaining, resetsAt? }` |
| `GET /api/mcp/v1/models` (ab v3) | `{ free, profiles: { code: [...], ... }, version }` |
| Fehler | HTTP 4xx/5xx + `{ "error": { "code", "message" } }` (429 bei Limit) |

## Cloudflare-Einstellungen (Workers Builds)

* Worker-Name: `ki-team-oauth-mcp` · Repository: `yannikzehnderyz-coder/ai`
* **Root-Verzeichnis: `ki-team-oauth-mcp`**
* Build-Befehl: leer · Bereitstellungsbefehl: `npx wrangler deploy`
* Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `KI_TEAM_PASSWORD`
* GitHub-OAuth-App: Homepage `https://ki-team-oauth-mcp.yannikzehnder-yz.workers.dev`,
  Callback `https://ki-team-oauth-mcp.yannikzehnder-yz.workers.dev/callback`
* Claude-Connector-URL: `https://ki-team-oauth-mcp.yannikzehnder-yz.workers.dev/mcp`

## Prüfung

GitHub Actions (`.github/workflows/ki-team-oauth-mcp.yml`) installiert, prüft TypeScript,
baut das Bundle per `wrangler deploy --dry-run` und führt `test/e2e.mjs` aus: kompletter
OAuth-Ablauf (inkl. Negativtests), alle Tools gegen den **echten** Hauptworker-Code
(`claude-ki-team/worker.js`) mit einer OpenRouter-Attrappe, Limits und Kostenschutz.
Es werden keine echten Zugangsdaten verwendet und nichts bereitgestellt.

## Bereitstellungsprotokoll

* 16.10.2026: Workers Builds auf Root-Verzeichnis `ki-team-oauth-mcp` und Branch `main` umgestellt;
  erster Build des sicheren Servers ersetzt die vorher bereitgestellte Cloudflare-Demo.
