"use client"

import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  FREE_REGISTRATION_API_PATH,
  FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
  isFreeRegistrationLeadId,
} from "@/lib/auth/free-registration"
import { EMAIL_ADDRESS_PATTERN } from "@/lib/email-deliverability-shared"
import { cn } from "@/lib/utils"

const RESEND_COOLDOWN_MS = 45_000
const SENT_MARKER_PREFIX = "chaarlie_free_registration_sent:"

const COPY = {
  inboxTitle: "Schau in dein Postfach.",
  inboxBodyWithEmail: (email: string) => `Wir haben dir einen Link an ${email} geschickt.`,
  inboxBody: "Wir haben dir einen Link geschickt.",
  inboxHint: "Tipp darauf, dann geht es weiter.",
  sending: "Dein Link wird gesendet.",
  resend: "Link erneut senden",
  resent: "Link gesendet.",
  correct: "Andere E-Mail-Adresse",
  correctTitle: "Wohin sollen wir den Link schicken?",
  emailLabel: "E-Mail-Adresse",
  emailInvalid: "Bitte gib eine gültige E-Mail-Adresse ein.",
  send: "Link senden",
  cancel: "Abbrechen",
  busy: "Wird gesendet…",
  expiredTitle: "Dieser Link ist abgelaufen.",
  expiredBody: "Wir schicken dir gern einen neuen.",
  expiredCta: "Neuen Link senden",
  noLeadTitle: "Wir konnten deine Haaranalyse nicht finden.",
  noLeadBody: "Starte sie neu – das dauert nur wenige Minuten.",
  noLeadCta: "Zur Haaranalyse",
  claimedTitle: "Für diese Haaranalyse gibt es schon ein Konto.",
  claimedCta: "Zum Login",
  correctionBlockedTitle: "Die Adresse lässt sich hier nicht mehr ändern.",
  correctionBlockedBody:
    "Aus Sicherheitsgründen geht das nur direkt nach der Haaranalyse. Starte sie neu – dann geht der Link an deine neue Adresse.",
  genericErrorTitle: "Das hat gerade nicht geklappt.",
  genericError: "Das hat gerade nicht geklappt. Bitte versuche es noch einmal.",
  retry: "Erneut versuchen",
} as const

const QUIZ_ENTRY_PATH = "/lp/haarplan"

export type Handoff = { leadId: string; email?: string; capability?: string }

type Phase =
  | "resolving"
  | "sending"
  | "inbox"
  | "correct"
  | "expired"
  | "no_lead"
  | "failed"
  | "correction_blocked"

/** Exported for direct unit testing (fix round 2, N2) — the phase machine
 * this sits behind lives behind `requestAnimationFrame` + `fetch`, same
 * reason `FreeRegistrationScreen` was split out in fix round 1 (W6). */
export function readHandoff(): Handoff | null {
  try {
    const raw = window.sessionStorage.getItem(FREE_REGISTRATION_HANDOFF_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (!isFreeRegistrationLeadId(record.leadId)) return null
    return {
      leadId: record.leadId,
      ...(typeof record.email === "string" && record.email ? { email: record.email } : {}),
      ...(typeof record.capability === "string" && record.capability
        ? { capability: record.capability }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * `capability === undefined` means "not an explicit correction" (a plain
 * resend, or the auto-send on mount) — the existing stored capability is
 * preserved rather than nulled out (fix round 2, review finding N2). Before
 * this, ANY successful send rewrote the handoff with `options.capability ??
 * null`, and a plain resend never carries a capability — so a genuine user
 * who resent, then reloaded within the 60-minute TTL, dead-ended on
 * `correction_blocked` even though their capability was still valid. Only an
 * explicit correction (which always passes its own capability, `string` or
 * `null`) is allowed to update/consume the stored value.
 */
export function writeHandoffEmail(
  leadId: string,
  email: string,
  capability: string | null | undefined,
) {
  try {
    const nextCapability =
      capability !== undefined
        ? capability
        : (() => {
            const existing = readHandoff()
            return existing && existing.leadId === leadId ? (existing.capability ?? null) : null
          })()
    window.sessionStorage.setItem(
      FREE_REGISTRATION_HANDOFF_STORAGE_KEY,
      JSON.stringify(
        nextCapability ? { leadId, email, capability: nextCapability } : { leadId, email },
      ),
    )
  } catch {
    /* A blocked sessionStorage only costs the address in the copy. */
  }
}

function hasSentMarker(leadId: string) {
  try {
    return window.sessionStorage.getItem(`${SENT_MARKER_PREFIX}${leadId}`) === "1"
  } catch {
    return false
  }
}

function setSentMarker(leadId: string) {
  try {
    window.sessionStorage.setItem(`${SENT_MARKER_PREFIX}${leadId}`, "1")
  } catch {
    /* Only affects whether a reload re-sends automatically. */
  }
}

type SendOutcome =
  | { ok: true; email?: string }
  | { ok: false; message: string; code?: string; suggestion?: string }

async function postFreeRegistration(
  leadId: string,
  email?: string,
  capability?: string | null,
): Promise<SendOutcome> {
  try {
    const response = await fetch(FREE_REGISTRATION_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The capability travels only with a correction — it is what authorizes
      // rewriting the lead's address (T18 fix round 1, W1a).
      body: JSON.stringify(
        email ? { leadId, email, ...(capability ? { capability } : {}) } : { leadId },
      ),
    })
    const payload: unknown = await response.json().catch(() => null)
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
    if (response.ok && record.ok === true) {
      return {
        ok: true,
        ...(typeof record.email === "string" ? { email: record.email } : {}),
      }
    }
    return {
      ok: false,
      message: typeof record.error === "string" ? record.error : COPY.genericError,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.suggestion === "string" ? { suggestion: record.suggestion } : {}),
    }
  } catch {
    return { ok: false, message: COPY.genericError }
  }
}

export function FreeRegistrationClient({
  leadIdFromUrl,
  expired,
}: {
  leadIdFromUrl: string | null
  expired: boolean
}) {
  const [phase, setPhase] = useState<Phase>("resolving")
  const [leadId, setLeadId] = useState<string | null>(leadIdFromUrl)
  const [email, setEmail] = useState<string | null>(null)
  const [capability, setCapability] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [draftEmail, setDraftEmail] = useState("")
  const bootstrappedRef = useRef(false)
  const draftInputRef = useRef<HTMLInputElement>(null)

  const send = useCallback(
    async (
      targetLeadId: string,
      options: { email?: string; capability?: string | null; notice?: string } = {},
    ) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      const outcome = await postFreeRegistration(targetLeadId, options.email, options.capability)
      setBusy(false)
      if (outcome.ok) {
        setSentMarker(targetLeadId)
        const nextEmail = outcome.email ?? options.email ?? null
        if (nextEmail) {
          setEmail(nextEmail)
          // Only an explicit correction (identified by carrying its own
          // `email`) is allowed to set/replace the stored capability — a
          // plain resend or the auto-send on mount passes `undefined`, which
          // `writeHandoffEmail` reads as "keep whatever is already stored".
          writeHandoffEmail(
            targetLeadId,
            nextEmail,
            options.email !== undefined ? (options.capability ?? null) : undefined,
          )
        }
        setClaimed(false)
        setPhase("inbox")
        setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
        if (options.notice) setNotice(options.notice)
        return true
      }
      // The server is the authority on whether a correction was authorized; a
      // stale or forged capability lands here just like a missing one.
      if (outcome.code === "correction_not_authorized") {
        setPhase("correction_blocked")
        return false
      }
      setClaimed(outcome.code === "lead_claimed")
      setError(outcome.message)
      setPhase((current) =>
        current === "correct" ? "correct" : current === "inbox" ? "inbox" : "failed",
      )
      return false
    },
    [],
  )

  // The lead handoff and the "already sent" marker live in sessionStorage, so
  // the bootstrap runs after paint (same pattern as the quiz entry) — which
  // also keeps every setState out of the effect body itself.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (bootstrappedRef.current) return
      bootstrappedRef.current = true

      const handoff = readHandoff()
      const resolvedLeadId = leadIdFromUrl ?? handoff?.leadId ?? null
      setLeadId(resolvedLeadId)
      const handoffMatchesLead = !leadIdFromUrl || leadIdFromUrl === handoff?.leadId
      if (handoff?.email && handoffMatchesLead) setEmail(handoff.email)
      // Only the browser that completed THIS quiz holds the capability — that is
      // the whole control (W1a), so it never travels with a lead id from the URL
      // unless the handoff is for that same lead.
      if (handoff?.capability && handoffMatchesLead) setCapability(handoff.capability)

      if (!resolvedLeadId) {
        setPhase("no_lead")
        return
      }
      if (expired) {
        setPhase("expired")
        return
      }
      if (hasSentMarker(resolvedLeadId)) {
        setPhase("inbox")
        return
      }
      setPhase("sending")
      void send(resolvedLeadId)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [expired, leadIdFromUrl, send])

  useEffect(() => {
    if (cooldownUntil <= now) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil, now])

  useEffect(() => {
    if (phase === "correct") draftInputRef.current?.focus()
  }, [phase])

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  function startCorrection() {
    // No capability, no correction — say so straight away instead of walking the
    // user through a form the server is going to refuse (W1a).
    if (!capability) {
      setError(null)
      setNotice(null)
      setPhase("correction_blocked")
      return
    }
    setDraftEmail(email ?? "")
    setError(null)
    setNotice(null)
    setPhase("correct")
  }

  async function submitCorrection(event: FormEvent) {
    event.preventDefault()
    if (busy || !leadId) return
    const candidate = draftEmail.trim()
    if (!EMAIL_ADDRESS_PATTERN.test(candidate)) {
      setError(COPY.emailInvalid)
      return
    }
    await send(leadId, { email: candidate, capability, notice: COPY.resent })
  }

  return (
    <FreeRegistrationScreen
      busy={busy}
      claimed={claimed}
      cooldownSeconds={cooldownSeconds}
      draftEmail={draftEmail}
      draftInputRef={draftInputRef}
      email={email}
      error={error}
      notice={notice}
      onCancelCorrection={() => {
        setError(null)
        setPhase("inbox")
      }}
      onDraftChange={(value) => {
        setDraftEmail(value)
        setError(null)
      }}
      onResend={() => leadId && void send(leadId, { notice: COPY.resent })}
      onStartCorrection={startCorrection}
      onSubmitCorrection={submitCorrection}
      phase={phase}
      resendDisabled={!leadId}
    />
  )
}

/**
 * Every screen state this route can show, as one pure function of its inputs.
 * Split out of `FreeRegistrationClient` in fix round 1 so the states are
 * reachable from a test (review finding W6): the client's phase machine lives
 * behind a `requestAnimationFrame` bootstrap and `fetch`, neither of which
 * `renderToStaticMarkup` runs.
 */
export function FreeRegistrationScreen({
  busy,
  claimed,
  cooldownSeconds,
  draftEmail,
  draftInputRef,
  email,
  error,
  notice,
  onCancelCorrection,
  onDraftChange,
  onResend,
  onStartCorrection,
  onSubmitCorrection,
  phase,
  resendDisabled = false,
}: {
  busy: boolean
  claimed: boolean
  cooldownSeconds: number
  draftEmail: string
  draftInputRef?: React.Ref<HTMLInputElement>
  email: string | null
  error: string | null
  notice: string | null
  onCancelCorrection: () => void
  onDraftChange: (value: string) => void
  onResend: () => void
  onStartCorrection: () => void
  onSubmitCorrection: (event: FormEvent) => void
  phase: Phase
  resendDisabled?: boolean
}) {
  if (phase === "resolving") return <Shell>{null}</Shell>

  if (phase === "no_lead") {
    return (
      <Shell state="no_lead">
        <h1 className={headingClass}>{COPY.noLeadTitle}</h1>
        <p className={bodyClass}>{COPY.noLeadBody}</p>
        <a className={linkCtaClass} href={QUIZ_ENTRY_PATH}>
          {COPY.noLeadCta}
        </a>
      </Shell>
    )
  }

  if (phase === "correction_blocked") {
    return (
      <Shell state="correction_blocked">
        <h1 className={headingClass}>{COPY.correctionBlockedTitle}</h1>
        <p className={bodyClass}>{COPY.correctionBlockedBody}</p>
        <a className={linkCtaClass} href={QUIZ_ENTRY_PATH}>
          {COPY.noLeadCta}
        </a>
      </Shell>
    )
  }

  if (phase === "correct") {
    return (
      <Shell state="correct">
        <form noValidate onSubmit={onSubmitCorrection}>
          <h1 className={headingClass}>{COPY.correctTitle}</h1>
          <div className="mt-8 text-left">
            <label
              className="text-sm font-semibold text-[var(--brand-plum-darkest)]"
              htmlFor="free-registration-email"
            >
              {COPY.emailLabel}
            </label>
            <Input
              aria-describedby={error ? "free-registration-error" : undefined}
              aria-invalid={Boolean(error)}
              autoComplete="email"
              className="mt-2 h-13 rounded-2xl border-[var(--brand-plum-light)] bg-white px-4 text-base"
              enterKeyHint="go"
              id="free-registration-email"
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="du@beispiel.de"
              ref={draftInputRef}
              spellCheck={false}
              type="email"
              value={draftEmail}
            />
          </div>
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          <Button className="mt-7" disabled={busy} type="submit" variant="funnelCta">
            {busy ? <BusyLabel /> : COPY.send}
          </Button>
          <Button
            className="mt-3 h-12 w-full rounded-[14px] border-[var(--brand-plum-light)] bg-white text-base text-[var(--brand-plum-darkest)] hover:bg-[var(--brand-plum-ice)]"
            disabled={busy}
            onClick={onCancelCorrection}
            type="button"
            variant="outline"
          >
            {COPY.cancel}
          </Button>
        </form>
      </Shell>
    )
  }

  if (phase === "failed" && claimed) {
    return (
      <Shell state="claimed">
        {/* The heading is ours, not the server's sentence (W7). */}
        <h1 className={headingClass}>{COPY.claimedTitle}</h1>
        {error ? <p className={bodyClass}>{error}</p> : null}
        <a className={linkCtaClass} href="/auth">
          {COPY.claimedCta}
        </a>
      </Shell>
    )
  }

  if (phase === "expired" || phase === "failed") {
    const isExpired = phase === "expired"
    return (
      <Shell state={isExpired ? "expired" : "failed"}>
        <h1 className={headingClass}>{isExpired ? COPY.expiredTitle : COPY.genericErrorTitle}</h1>
        {/* One sentence, never the same one twice (W7): the expired state
            explains itself, the failed state shows the server's reason. */}
        {isExpired ? (
          <p className={bodyClass}>{COPY.expiredBody}</p>
        ) : (
          <ErrorLine>{error ?? COPY.genericError}</ErrorLine>
        )}
        <Button
          className="mt-7"
          disabled={busy || resendDisabled}
          onClick={onResend}
          type="button"
          variant="funnelCta"
        >
          {busy ? <BusyLabel /> : isExpired ? COPY.expiredCta : COPY.retry}
        </Button>
      </Shell>
    )
  }

  const sending = phase === "sending" || (busy && phase === "inbox")

  return (
    <Shell state={sending ? "sending" : "inbox"}>
      <h1 className={headingClass}>{COPY.inboxTitle}</h1>
      <p className={bodyClass} data-free-registration-body>
        {sending ? COPY.sending : email ? COPY.inboxBodyWithEmail(email) : COPY.inboxBody}
      </p>
      {!sending ? <p className={cn(bodyClass, "mt-2")}>{COPY.inboxHint}</p> : null}
      {notice ? (
        <p
          aria-live="polite"
          className="mt-5 text-sm font-semibold text-[var(--brand-plum)]"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button
        className="mt-7"
        disabled={busy || resendDisabled || cooldownSeconds > 0}
        onClick={onResend}
        type="button"
        variant="funnelCta"
      >
        {busy ? (
          <BusyLabel />
        ) : cooldownSeconds > 0 ? (
          `${COPY.resend} (${cooldownSeconds})`
        ) : (
          COPY.resend
        )}
      </Button>
      <Button
        className="mt-3 h-12 w-full rounded-[14px] border-[var(--brand-plum-light)] bg-white text-base text-[var(--brand-plum-darkest)] hover:bg-[var(--brand-plum-ice)]"
        disabled={busy}
        onClick={onStartCorrection}
        type="button"
        variant="outline"
      >
        {COPY.correct}
      </Button>
    </Shell>
  )
}

const headingClass =
  "text-balance font-header text-[2rem] font-medium leading-tight text-[var(--brand-plum-darkest)] sm:text-[2.4rem]"
const bodyClass = "mt-3 leading-7 text-[var(--text-sub)]"
const linkCtaClass =
  "mt-7 inline-flex min-h-14 w-full items-center justify-center rounded-full bg-[var(--brand-coral)] px-6 text-base font-bold text-white transition hover:bg-[var(--brand-coral-dark)]"

function BusyLabel() {
  return (
    <>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {COPY.busy}
    </>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-4 text-sm font-semibold text-destructive"
      id="free-registration-error"
      role="alert"
    >
      {children}
    </p>
  )
}

function Shell({ children, state }: { children: ReactNode; state?: string }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[hsl(var(--background))] px-5 py-10">
      <section
        className="mx-auto w-full max-w-[36rem] text-center"
        data-free-registration
        data-free-registration-state={state}
      >
        {children}
      </section>
    </main>
  )
}
