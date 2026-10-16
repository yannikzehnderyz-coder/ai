# KI-Team MCP – Prüfbericht
Commit: 9293f85b67828ff6d3db8fe033486da0835a381b · Ref: ki-team-main-worker-deploy · Lauf: https://github.com/yannikzehnderyz-coder/ai/actions/runs/38896926666

| Schritt | Ergebnis |
|---|---|
| Installation | success |
| TypeScript | success |
| Bundle (dry-run) | success |
| Hauptworker-Bundle (dry-run) | success |
| End-to-End-Test | success |

## install
```

added 223 packages in 5s
```

## typecheck
```
```

## build
```

 ⛅️ wrangler 4.151.0
────────────────────
Total Upload: 2643.80 KiB / gzip: 480.57 KiB
Your Worker has access to the following bindings:
Binding                                                                      Resource                  
env.MCP_OBJECT (MyMCP)                                                       Durable Object            
env.USAGE_LIMITER (UsageLimiter)                                             Durable Object            
env.PROJECT_STORE (ProjectStore)                                             Durable Object            
env.OAUTH_KV (328dc2347f26431ab765fb47ddb5adbc)                              KV Namespace              
env.KI_TEAM (claude-ki-team)                                                 Worker                    
env.ALLOWED_GITHUB_USER_IDS ("340084289")                                    Environment Variable      
env.ALLOWED_REDIRECT_URIS ("https://claude.ai/api/mcp/auth_callback")        Environment Variable      
env.MCP_DAILY_LIMIT ("20")                                                   Environment Variable      
env.MCP_PER_MINUTE_LIMIT ("6")                                               Environment Variable      
env.COORDINATOR_ROLE ("KI-Koordination")                                     Environment Variable      
env.VERIFY_ROLE ("Kritische Prüfung")                                        Environment Variable      
env.QUALITY_RESERVE ("4")                                                    Environment Variable      
env.CACHE_TTL_MINUTES ("360")                                                Environment Variable      
env.ALLOWED_REVIEW_OWNERS ("yannikzehnderyz-coder")                          Environment Variable      

--dry-run: exiting now.
```

## build-main
```

added 38 packages in 5s

 ⛅️ wrangler 4.151.1
────────────────────
Total Upload: 12.78 KiB / gzip: 4.73 KiB
Your Worker has access to the following bindings:
Binding                                               Resource          
env.LIMITS_KV (e9bfead1afcf47eea88d640cd684a644)      KV Namespace      

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
  ✔ Server-Version 3.0.0
  ✔ Alle 6 bisherigen Tools weiterhin vorhanden
  ✔ 6 neue Tools vorhanden (12 gesamt)
  ✔ Demo-Tool 'add' entfernt
  ✔ ki_team_status
  ✔ Status zeigt nur kostenlose Modelle (4) und Routing
  ✔ ki_team_list_roles liefert 26 Rollen
8a) Einzelauftrag, Cache, Qualitätsprüfung
  ✔ ki_team_run_role erreicht Hauptworker + OpenRouter
  ✔ Automatische Qualitätsprüfung ohne Befund
  ✔ Identische Anfrage kommt aus dem Cache (0 Aufrufe)
  ✔ fresh=true umgeht den Cache
  ✔ Unbekannte Rolle → Fehler ohne Verbrauch
8b) Delegation und Zusammenarbeit (bestehende Funktionen)
  ✔ ki_team_auto_delegate wählt Rolle und führt aus
  ✔ ki_team_collaborate parallel + Zusammenfassung
  ✔ Modell-Routing: Programmierung → Code-Modell
  ✔ Modell-Routing: Sicherheit → Reasoning-Modell
  ✔ ki_team_collaborate sequenziell, Teilfehler wird gemeldet
8c) Datenschutz vor Weitergabe an externe Modelle
  ✔ Zugangsdaten werden blockiert (0 Aufrufe)
  ✔ Personenbezogene Daten → Rückfrage (0 Aufrufe)
  ✔ Mit Zustimmung wird ausgeführt
  ✔ Zugangsdaten auch mit Zustimmung blockiert
8d) Qualitätsprüfung + gezielte Nachprüfung
  ✔ Abgeschnittene Antwort wird erkannt
  ✔ Automatische Nachprüfung bei gravierendem Befund (+1 Aufruf)
  ✔ verify=never → keine Nachprüfung
  ✔ ki_team_quality_check ohne KI-Aufruf
  ✔ Verweigerung wird erkannt
8e) Projektgedächtnis
  ✔ Projekt anlegen + Entscheidung speichern
  ✔ Geheimnisse werden nicht gespeichert
  ✔ Zweites Projekt angelegt
  ✔ Projektliste
  ✔ Projektkontext (Ziel + Entscheidung) wird mitgegeben
  ✔ Strikte Trennung: anderes Projekt kennt die Entscheidung nicht
  ✔ Projekt abrufen: Ziel, Entscheidung, Arbeitsstand
  ✔ Unbekanntes Projekt → Fehler
  ✔ Unbekanntes Projekt beim Auftrag → Fehler ohne Verbrauch
8f) Mehrstufige Teamarbeit
  ✔ Kostenschätzung ohne Ausführung
  ✔ Pipeline: 3 Schritte nacheinander mit Übergabe
  ✔ Pipeline hält bei gravierendem Problem an und gibt Budget zurück
8g) Code- und Projektprüfung (nur lesend)
  ✔ Statische Prüfung findet eval + XSS
  ✔ KI-Prüfung durch Codeprüfung + Sicherheit mit Code-Profil
  ✔ Nur lesend
  ✔ Code mit Zugangsdaten: statische Prüfung ja, KI-Prüfung nein
  ✔ PR von GitHub laden: SQL-Injection + XSS + fehlende Tests
  ✔ Nicht freigegebener Besitzer wird abgelehnt
  ✔ ki_team_usage zeigt beide Limits, Cache und Nachprüfungen
9) Atomares Limit bei parallelen Aufrufen
  ✔ Genau 18 von 21 parallelen Aufrufen erlaubt
  ✔ Nach Erreichen des Limits → abgelehnt
  ✔ Collaborate wird vorab abgelehnt, wenn Budget nicht reicht
  ✔ Cache funktioniert auch bei ausgeschöpftem Limit
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
  ✔ Nur :free-Modelle mit Preis 0 wurden aufgerufen
  ✔ Kostenpflichtige / falsch markierte Modelle nie benutzt (auch nicht beim Routing)

Ergebnis: 95 bestanden, 0 fehlgeschlagen
```
