# Scanner-Angebotsseite nach dem Quiz

Stand: 13.09.2026. Entscheidung von Jonas: Der Quiz-Funnel führt nach dem Quiz nicht mehr auf die Haarplan-Angebotsseite, sondern auf eine Scanner-Seite. Der Scanner ist das Hauptprodukt, verkauft wird er über eine 7-Tage-Testphase.

## Was in diesem PR ist

| Datei | Was |
|---|---|
| `src/components/scanner-offer/scanner-offer.tsx` | Die Seite als Client-Komponente mit typisiertem Model. Kein Checkout, kein Tracking, keine Datenbank. |
| `src/app/labs/scanner-offer/page.tsx` | Lab-Route `/labs/scanner-offer` mit Beispieldaten, gleiche Sperre wie `/labs/offer-page`. |
| `public/images/funnels/scanner-offer/` | Regal-Foto mit dem offenen Scanner (Composite aus dem Ad-Set) und die Beispiel-Auswertung als Geräte-Screen in voller Auflösung, ohne Preis und Kaufen-Button. |
| `docs/scanner-offer/mockups/` | Die abgenommenen HTML-Mockups: `scanner-offer-page.html` (die Seite, klickbar) und `quiz-scanner-flow.html` (die geänderten Quiz-Screens mit Probescan). Direkt im Browser öffnen. |

Die Komponente ist bewusst frei von App-Logik, damit sie sich an der Stelle der heutigen `PersonalPlanOffer` einhängen lässt, sobald die Punkte unten stehen.

## Aufbau der Seite (Reihenfolge ist Teil der Spec)

1. **Haarprofil.** Vorname, ein Satz („Welliges, feines Haar mit mittlerer Dichte.“), Chips aus den Quiz-Antworten, die drei Ausgangslage-Dimensionen aus dem bestehenden `publicOfferModel`, „Das Gute“.
2. **Brücke.** „Der Scanner zeigt dir, ob deine Produkte zu Hause oder in der Drogerie zu deinen Haaren passen. Handy dranhalten, eine Sekunde: passt oder passt nicht. Mit dem Grund. Und zu jedem, was nicht passt, drei Alternativen.“
3. **So sieht der Scanner aus.** Regal-Foto mit Hand, Handy und offenem Scanner (Composite aus dem Ad-Set, Screen ist der echte App-Screen).
4. **So sieht die Auswertung aus.** Echter Ergebnis-Screen als Geräte-Bild in voller Auflösung (Statusleiste komplett, unten ausgeblendet), als Beispiel markiert, mit fester Profilangabe. Es wird **kein Produkt der Person bewertet**, das Quiz fragt keins ab.
5. **Freischalten.** Trial-Box mit Zeitleiste (Heute, Tag 5, Tag 7), zwei Tarife, beide mit 7 Tagen kostenlos, Jahr vorausgewählt, Button „Scanner freischalten, 7 Tage kostenlos“, Folgepreis im Kleingedruckten.
6. **Was in der Testphase drin ist.** Fünf Zeilen, alle „frei“.
7. **Stimmen aus der Beta.** Die drei bestehenden Textzitate. Videos (Steffi, Lucy) kommen später von Jonas.
8. **FAQ.** Fünf Fragen, auf Trial und Scanner gedreht.
9. **Footer** über `SiteFooter` (Impressum, Datenschutz, AGB, Widerruf, Kontakt).

Dazu: Sticky-CTA auf Mobile (erscheint, sobald die Trial-Box nach oben aus dem Bild ist) und WhatsApp-Button unten rechts.

## Was noch zu verdrahten ist

### Daten
- `profileHeadline`: aus `profileLine` des Prepared Artifact ableiten (heute „Basierend auf deiner Analyse für …“).
- `profileChips`: `buildScannerProfileChips(quizAnswers)` in der Komponente, erwartet die gespeicherten `QuizAnswers` des Leads.
- `diagnosticRows`: `publicOfferModel.diagnosticRows`, unverändert.
- `encouragement`: ein Satz aus der Diagnose. Im Lab hart codiert.

### Checkout und Trial
- Beide Stripe-Preise (Monat 9,99 €, Jahr 69,99 €) mit `trial_period_days: 7`, `payment_method_collection: "always"`, `trial_settings.end_behavior.missing_payment_method: "cancel"`.
- Status `trialing` wird von `payment-integrity-runtime` und `plan-change` bereits als bezahlt behandelt.
- Einmaligkeit: beim ersten Trial `has_ever_trialed = true` am Stripe-Kunden setzen (Metadata) und am Lead spiegeln. Wenn gesetzt: Box ohne Trial rendern (Tag und Zeitleiste ausblenden, `detail` und `afterTrialLabel` ohne „7 Tage kostenlos“).
- Button-Text im Overlay muss den Folgepreis nennen (§ 312j BGB): „Testphase starten, danach 69,99 €/Jahr“, nicht nur „Kostenlos testen“.
- PayPal: Subscription-Plan mit kostenloser erster Periode, sonst PayPal nur ohne Trial anbieten.
- `onUnlock(planId)` der Komponente öffnet den Checkout, analog zu `ResultOfferPricing` im Membership-Modus.

### E-Mail
- Erinnerung an Tag 5 als Transaktionsmail auf `customer.subscription.trial_will_end` (Stripe feuert 3 Tage vor Ende). Pflicht, nicht optional.

### Ereignisse (PostHog, Customer.io, Meta CAPI)
| Ereignis | Wann |
|---|---|
| `scanner_page_viewed` | Seite gerendert (ersetzt `offer_viewed` für diese Variante) |
| `paywall_viewed` | Trial-Box im Viewport |
| `offer_cta_clicked` mit `position: sticky \| inline` | Klick auf Freischalten |
| `checkout_opened` mit `plan`, `price`, `trial: true` | Overlay offen |
| `trial_started` | Stripe-Webhook |
| `whatsapp_clicked` | Klick auf den WhatsApp-Button |

### Später: echte Scan-Komponenten statt Screenshots
Der Scanner existiert in `src/components/scan/` (`scan-result-card.tsx`, `scan-dimension-bar.tsx`, `scan-masked-alternatives.tsx`). Sobald ein Beispiel-Ergebnis als Fixture vorliegt, kann Block 4 („So sieht die Auswertung aus“) die echte `ScanResultCard` rendern statt des Screenshots. Dann bleibt die Seite automatisch mit der App synchron.

### Konfiguration
- WhatsApp-Nummer und Vorlagentext als Env (`NEXT_PUBLIC_WHATSAPP_NUMBER`), vorausgefüllt mit Vorname und Profil.
- `data-offer-variant="scanner-offer-v1"` steht am Root, `data-offer-section` an jeder Sektion für PostHog-Heatmaps und Tests.

## Entscheidungen, die schon gefallen sind

- Trial auf **beiden** Tarifen für den ersten Test (Jonas, 12.09.). Danach wird auf „Trial nur Jahr“ gewechselt, wenn der Jahresanteil unter 25 % liegt.
- Kein Produkt im Quiz, kein bewertetes Produkt auf der Seite.
- Streichpreise raus. „5,83 € im Monat“ ist die Rechnung, kein Vergleichspreis.
- Scanner im Trial komplett offen (keine Mengensperre).

## Quiz-Änderungen (separater Schritt, gehört nicht in diesen PR)

`docs/scanner-offer/mockups/quiz-scanner-flow.html` zeigt die acht Quiz-Screens, die den Scanner ins Quiz holen: Scan-Loop auf dem Landing-Hero, vier Achsen, die sich sichtbar füllen, ein **Probescan** mit vorgeladenem Beispielprodukt als Zwischenstopp nach Frage 6, eine Schätzfrage „Wie viele Produkte stehen bei dir im Bad?“, E-Mail als Scanner-Zugang, Micro-Commitment und Reveal auf den Scanner gedreht. Alles Copy und ein Zwischenscreen, keine neue Engine-Logik.

## Lab starten

```bash
npm run dev
# dann http://localhost:3000/labs/scanner-offer
```
