# KI-Team MCP – Prüfbericht
Commit: 56f1223d8454299dc5ffea1d75bc9375d34e04ee · Ref: 1/merge · Lauf: https://github.com/yannikzehnderyz-coder/ai/actions/runs/38870990545

| Schritt | Ergebnis |
|---|---|
| Installation | success |
| TypeScript | success |
| Bundle (dry-run) | success |
| End-to-End-Test | success |

## install
```

added 223 packages in 7s
```

## typecheck
```
```

## build
```

 ⛅️ wrangler 4.151.0
────────────────────
Total Upload: 2593.06 KiB / gzip: 465.98 KiB
Your Worker has access to the following bindings:
Binding                                                                      Resource                  
env.MCP_OBJECT (MyMCP)                                                       Durable Object            
env.USAGE_LIMITER (UsageLimiter)                                             Durable Object            
env.OAUTH_KV (328dc2347f26431ab765fb47ddb5adbc)                              KV Namespace              
env.KI_TEAM (claude-ki-team)                                                 Worker                    
env.ALLOWED_GITHUB_USER_IDS ("340084289")                                    Environment Variable      
env.ALLOWED_REDIRECT_URIS ("https://claude.ai/api/mcp/auth_callback")        Environment Variable      
env.MCP_DAILY_LIMIT ("20")                                                   Environment Variable      
env.MCP_PER_MINUTE_LIMIT ("6")                                               Environment Variable      
env.COORDINATOR_ROLE ("KI-Koordination")                                     Environment Variable      

--dry-run: exiting now.
```

## e2e
```
wrangler dev läuft.

1) Unauthentifizierter Zugriff
  ✔ /mcp ohne Token → 401
  ✔ 401 enthält WWW-Authenticate
  ✔ /mcp mit falschem Token → 401
2) Discovery
  ✔ Authorization-Server-Metadaten vorhanden
  ✔ PKCE S256 wird angeboten
  ✔ Protected-Resource-Metadaten vorhanden
3) Client-Registrierung
  ✔ Fremde Redirect-URI wird abgelehnt
  ✔ Claude-Client wird registriert
4) /authorize-Prüfungen
  ✔ Ohne PKCE → abgelehnt
  ✔ PKCE plain → abgelehnt
  ✔ Fremde redirect_uri → abgelehnt
  ✔ Freigabeseite wird angezeigt
  ✔ Freigabeseite enthält keine OAuth-Rohdaten
5) CSRF
  ✔ Falsches CSRF-Token → 403
  ✔ Ohne CSRF-Cookie → abgelehnt
  ✔ Weiterleitung zu GitHub
6) GitHub-Callback
  ✔ Callback ohne Browser-Bindung → abgelehnt
  ✔ Fremder GitHub-Account → 403
  ✔ Erlaubter Account → Redirect zu Claude mit Code
  ✔ Claude-state wird zurückgegeben
  ✔ state ist nur einmal verwendbar
7) Token-Ausgabe
  ✔ Falscher PKCE-Verifier → abgelehnt
  ✔ Access-Token wird ausgestellt
  ✔ Refresh-Token wird ausgestellt
8) MCP
  ✔ MCP initialize
  ✔ Alle 6 Tools vorhanden
  ✔ Demo-Tool 'add' entfernt
  ✔ ki_team_status
  ✔ ki_team_list_roles liefert 26 Rollen
  ✔ ki_team_run_role erreicht Hauptworker + OpenRouter
  ✔ Unbekannte Rolle → Fehler ohne Verbrauch
  ✔ ki_team_auto_delegate wählt Rolle und führt aus
  ✔ ki_team_collaborate parallel + Zusammenfassung
  ✔ ki_team_collaborate sequenziell, Teilfehler wird gemeldet
  ✔ Collaborate wird vorab abgelehnt, wenn Budget nicht reicht
  ✔ ki_team_usage zeigt beide Limits
9) Atomares Limit bei parallelen Aufrufen
  ✔ Genau 3 von 6 parallelen Aufrufen erlaubt (Restbudget 3)
  ✔ Nach Erreichen des Limits → abgelehnt
10) Keine Secrets in Antworten
  ✔ Keine Secrets in MCP-Ausgaben
11) Hauptworker direkt (Weboberfläche + Schutz der internen API)
  ✔ Weboberfläche lädt
  ✔ /api/chat mit falschem Passwort → 401
  ✔ Ohne Passwort-Header → 401 (keine Ausnahme)
  ✔ Leeres Passwort → 401
  ✔ Sehr langes Passwort → 401
  ✔ Gleich langes, falsches Passwort → 401
  ✔ Passwort mit Zusatzzeichen → 401
  ✔ Passwort mit fehlendem Zeichen → 401
  ✔ Sonderzeichen-Passwort → 401
  ✔ /api/mcp/v1/roles ohne Passwort → 401
  ✔ /api/mcp/v1/usage ohne Passwort → 401
  ✔ /api/mcp/v1/health ohne Passwort → 401
  ✔ /api/mcp/v1/run mit falschem Passwort → 401
  ✔ /api/chat liefert Antwort
  ✔ Fallback auf zweites Free-Modell
  ✔ 3. Anfrage erlaubt
  ✔ Tageslimit des Hauptworkers greift (429)
  ✔ Nutzung wird korrekt gemeldet
12) Kostenschutz
  ✔ Nur :free-Modelle wurden aufgerufen
  ✔ Kostenpflichtiges / falsch markiertes Modell nie benutzt

Ergebnis: 59 bestanden, 0 fehlgeschlagen
```
