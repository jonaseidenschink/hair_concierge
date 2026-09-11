import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { FreeRegistrationScreen } from "../src/app/registrierung/free-registration-client"

/**
 * T18 fix round 1 (review finding W6): `/registrierung` had no test of any
 * kind. Its phase machine lives behind a `requestAnimationFrame` bootstrap and
 * `fetch`, neither of which `renderToStaticMarkup` runs, so the presentation was
 * split into the pure `FreeRegistrationScreen` — these tests pin every screen
 * state the route can reach, including the new missing-capability refusal.
 */

const NOOP = () => {}

function render(overrides: Partial<Parameters<typeof FreeRegistrationScreen>[0]> = {}) {
  return renderToStaticMarkup(
    <FreeRegistrationScreen
      busy={false}
      claimed={false}
      cooldownSeconds={0}
      draftEmail=""
      email="lena@example.com"
      error={null}
      notice={null}
      onCancelCorrection={NOOP}
      onDraftChange={NOOP}
      onResend={NOOP}
      onStartCorrection={NOOP}
      onSubmitCorrection={NOOP}
      phase="inbox"
      {...overrides}
    />,
  )
}

test("inbox names the address the link went to and offers resend + correction", () => {
  const html = render()
  assert.match(html, /data-free-registration-state="inbox"/)
  assert.match(html, /Schau in dein Postfach\./)
  assert.match(html, /Wir haben dir einen Link an lena@example\.com geschickt\./)
  assert.match(html, /Link erneut senden/)
  assert.match(html, /Andere E-Mail-Adresse/)
})

test("inbox falls back to generic copy when the address is unknown", () => {
  const html = render({ email: null })
  assert.match(html, /Wir haben dir einen Link geschickt\./)
  assert.doesNotMatch(html, /an\s+null/)
})

test("sending shows the in-flight line and no inbox hint yet", () => {
  const html = render({ phase: "sending" })
  assert.match(html, /data-free-registration-state="sending"/)
  assert.match(html, /Dein Link wird gesendet\./)
  assert.doesNotMatch(html, /Tipp darauf/)
})

test("resend is disabled during the cooldown and counts it down", () => {
  const html = render({ cooldownSeconds: 42 })
  assert.match(html, /Link erneut senden \(42\)/)
  assert.match(html, /disabled/)
})

test("the resend notice is announced politely", () => {
  const html = render({ notice: "Link gesendet." })
  assert.match(html, /role="status"/)
  assert.match(html, /Link gesendet\./)
})

test("correction shows the labelled e-mail form", () => {
  const html = render({ phase: "correct", draftEmail: "lena.neu@example.com" })
  assert.match(html, /data-free-registration-state="correct"/)
  assert.match(html, /Wohin sollen wir den Link schicken\?/)
  assert.match(html, /for="free-registration-email"/)
  assert.match(html, /value="lena\.neu@example\.com"/)
  assert.match(html, /Link senden/)
  assert.match(html, /Abbrechen/)
})

test("a correction validation error is wired to the field via aria", () => {
  const html = render({ phase: "correct", error: "Bitte gib eine gültige E-Mail-Adresse ein." })
  assert.match(html, /aria-describedby="free-registration-error"/)
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /role="alert"/)
})

test("W1a: the missing/refused-capability state is honest and points back to the quiz", () => {
  const html = render({ phase: "correction_blocked" })
  assert.match(html, /data-free-registration-state="correction_blocked"/)
  assert.match(html, /Die Adresse lässt sich hier nicht mehr ändern\./)
  assert.match(html, /Starte sie neu – dann geht der Link an deine neue Adresse\./)
  assert.match(html, /href="\/lp\/haarplan"/)
  // It is a dead end for the correction only — no form to retry into.
  assert.doesNotMatch(html, /free-registration-email/)
})

test("expired explains itself and offers a fresh link", () => {
  const html = render({ phase: "expired" })
  assert.match(html, /data-free-registration-state="expired"/)
  assert.match(html, /Dieser Link ist abgelaufen\./)
  assert.match(html, /Wir schicken dir gern einen neuen\./)
  assert.match(html, /Neuen Link senden/)
})

test("no_lead sends the visitor back to the quiz", () => {
  const html = render({ phase: "no_lead" })
  assert.match(html, /data-free-registration-state="no_lead"/)
  assert.match(html, /Wir konnten deine Haaranalyse nicht finden\./)
  assert.match(html, /Starte sie neu – das dauert nur wenige Minuten\./)
  assert.match(html, /href="\/lp\/haarplan"/)
})

test("claimed offers the login, with our own heading (W7)", () => {
  const html = render({
    phase: "failed",
    claimed: true,
    error: "Für diese Haaranalyse gibt es schon ein Konto. Bitte melde dich an.",
  })
  assert.match(html, /data-free-registration-state="claimed"/)
  assert.match(html, /<h1[^>]*>Für diese Haaranalyse gibt es schon ein Konto\.<\/h1>/)
  assert.match(html, /href="\/auth"/)
})

test("W7: a failed send prints the reason once, not twice", () => {
  const message = "Der Link konnte nicht gesendet werden. Bitte versuche es noch einmal."
  const html = render({ phase: "failed", error: message })
  assert.match(html, /data-free-registration-state="failed"/)
  assert.match(html, /<h1[^>]*>Das hat gerade nicht geklappt\.<\/h1>/)
  assert.equal(html.split(message).length - 1, 1, "the server's sentence must appear exactly once")
  assert.match(html, /Erneut versuchen/)
})

test("resolving renders the empty shell (no flash of the wrong state)", () => {
  const html = render({ phase: "resolving" })
  assert.match(html, /data-free-registration/)
  assert.doesNotMatch(html, /Schau in dein Postfach/)
  assert.doesNotMatch(html, /Haaranalyse nicht finden/)
})
