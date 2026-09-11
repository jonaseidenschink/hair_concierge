import { PREMIUM_FEATURES, type PremiumSheetContext } from "@/lib/premium-sheet/context"

/**
 * What a redirect-based payment has to come back to (freemium-scanner-first T14, fix round
 * 1 F2; extended by the Codex fix wave, Y3).
 *
 * A card payment finishes inside the mounted sheet, so nothing is ever stored. A redirect
 * method (PayPal through Stripe embedded checkout) leaves the app entirely: the buyer
 * returns on a FRESH page load, where the sheet is closed and the opener's client state —
 * including which gate opened it — is gone. `sanitizeFreemiumCheckoutReturnPath` gets the
 * buyer back to the right SURFACE; this gets them back to the right SHEET.
 *
 * Two values, with deliberately different lifetimes:
 *
 *  - the **context** (which gate opened the sheet) — cosmetic, drives the benefit order;
 *  - the **Session id** of a verification that has not reached a terminal answer yet.
 *    The return effect strips the `?freemium_checkout=` parameter immediately so a refresh
 *    or a shared link cannot replay it — which used to mean a refresh WHILE the payment was
 *    still settling lost the only handle on it. Storing it here is what makes the pending
 *    state survive a reload.
 *
 * Both are dropped only on a TERMINAL outcome (unlocked, failed, unrecoverable). Reading
 * used to clear, which is precisely the bug: the context was gone before verification had
 * said anything.
 *
 * `sessionStorage`, not `localStorage`: this belongs to one tab's one purchase attempt, and
 * a stale value must not outlive it. Every access is wrapped — a private window, blocked
 * site data or a serialization failure degrades to "nothing remembered", which is the
 * opener's own default, never an error.
 */
const STORAGE_KEY = "chaarlie.premium-sheet.checkout-context"
const PENDING_SESSION_KEY = "chaarlie.premium-sheet.pending-session"

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  const store = sessionStore()
  if (!store) return
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    // A full or blocked store costs the buyer the benefit order, nothing else.
  }
}

function read(key: string): string | null {
  const store = sessionStore()
  if (!store) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

export function persistPremiumSheetCheckoutContext(context: PremiumSheetContext | null): void {
  write(STORAGE_KEY, context ? JSON.stringify(context) : null)
}

/**
 * Reads the stored context WITHOUT clearing it. A pending payment can outlive several page
 * loads, and every one of them has to be able to reopen on the gate the purchase started
 * from — so the value is dropped by `clearPremiumSheetCheckoutMemo`, on a terminal outcome,
 * and nowhere else.
 */
export function readPremiumSheetCheckoutContext(): PremiumSheetContext | null {
  const raw = read(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const candidate = parsed as { feature?: unknown; source?: unknown }
    // Browser-supplied storage is untrusted input like any other: only a real feature id
    // and a string source survive.
    if (typeof candidate.feature !== "string" || typeof candidate.source !== "string") return null
    if (!(candidate.feature in PREMIUM_FEATURES)) return null
    return {
      feature: candidate.feature as PremiumSheetContext["feature"],
      source: candidate.source,
    }
  } catch {
    return null
  }
}

/**
 * Remembers the Session a verification is still waiting on, so a refresh mid-`pending`
 * resumes instead of losing the purchase. Written the moment the machine enters
 * verification — for the in-sheet lane too, not just the redirect one.
 */
export function persistPremiumSheetPendingSession(sessionId: string): void {
  write(PENDING_SESSION_KEY, sessionId)
}

/** A Stripe Checkout Session id only; anything else in the store is ignored. */
export function readPremiumSheetPendingSession(): string | null {
  const raw = read(PENDING_SESSION_KEY)
  if (!raw || !raw.startsWith("cs_") || raw.length > 200) return null
  return raw
}

/** Both values, dropped together once the purchase can no longer change on its own. */
export function clearPremiumSheetCheckoutMemo(): void {
  write(STORAGE_KEY, null)
  write(PENDING_SESSION_KEY, null)
}
