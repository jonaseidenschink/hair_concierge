# Freemium Scanner-First — GEPARKT (Stand: 11.09.2026)

Das komplette Freemium-Restrukturierungsprogramm (PRs #525–#530, Tasks T1–T19) ist auf
`main` gemerged und **dunkel geparkt**: Entscheidung Nick + Jonas vom 11.09.2026, das
Freemium-Modell vorerst nicht zu launchen.

## Zustand

- **Flag `FREEMIUM_SCANNER_FIRST_ENABLED` ist nirgends gesetzt** → jede Nutzerin sieht das
  heutige Produkt byte-identisch (durch Replay-/Parity-Suiten dauerhaft in CI abgesichert).
- Die fünf Programm-Migrationen sind in Produktion **angewendet** (additiv, ungenutzt,
  harmlos): `scan_free_reveals`, `freemium_plan_admissions`, Terminal-Outcome- und
  Provenance-Spalten auf `leads`, PayPal-Source-CHECK.
- Neue Endpoints (Registrierung, Reveal, Purchase-Complete) sind deployt, antworten aber
  flag-off mit 404/Refusal.
- Der Migrations-Ledger wurde beim Apply mit der CLI versöhnt. **Regel ab jetzt:
  Migrationen nur noch über `supabase db push`, nie über den MCP** (sonst driftet der
  Ledger erneut).

## Reaktivierung (wenn es soweit ist)

1. **Erst richtig reviewen** (Nick, 11.09.2026: Review wurde beim Parken bewusst
   übersprungen): kompletter Produkt-Review + Journey-Walkthrough, dazu die geparkten
   Copy-/Preis-Entscheidungen auffrischen (Preisanker Quartal, „Später", Preisformate,
   Erwartungszeile im Quiz-Intro erwähnt die E-Mail nicht).
2. **Offene Bauarbeit:** der organische `/quiz`-Flow (Legacy-Quiz) hat nach dem Ergebnis
   noch KEINE Übergabe in die neue Welt — Ruling vom 11.09.: Legacy-Quiz bleibt, aber der
   Offer-Moment danach wechselt flag-on in den neuen Unlock. Ungelöst dabei: Legacy-Leads
   haben kein Prepared-Plan-Artefakt fürs Provisioning. Der neue Flow selbst läuft nur über
   die Personal-Plan-Quiz-Funnels (`/lp/haarplan`, braucht zusätzlich
   `PERSONAL_PLAN_QUIZ_V1_ENABLED`).
3. **Dann der Flip:** `docs/freemium-flag-flip-runbook.md` — Migrationen sind schon durch
   (Precondition 1 ✅); bleibt: Signing-Secret prüfen, Flag setzen + Redeploy (beides,
   Vercel!), Produktions-Zahlungstest (Karte + PayPal), Journey-Drive mit dem
   Standard-Testaccount **ab der Produktions-Landingpage** (nicht auf Komponentenebene —
   Lehre aus dem Live-Fund vom 11.09.), explizites GO.
4. Backlog-Anker: Scanner-Produkte im Routine-Editor platzierbar machen
   (Portfolio-Anbindung); Reaktivierungs-UX aus Keepsake-Evidenz.

## Wo alles liegt

Entscheidungshistorie: Memory `project_freemium_scanner_first`. PR-Beschreibungen #525–#530
sind die Programm-Doku. Flip-Runbook: `docs/freemium-flag-flip-runbook.md`.
