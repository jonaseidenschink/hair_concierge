"use client"

import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"

import { usePlanSelection } from "@/components/checkout/use-plan-selection"
import { PremiumSheetCheckout } from "@/components/premium-sheet/premium-sheet-checkout"
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import {
  FREEMIUM_CHECKOUT_RETURN_PARAM,
  sanitizeFreemiumCheckoutReturnPath,
} from "@/lib/freemium/checkout-return"
import {
  clearPremiumSheetCheckoutMemo,
  persistPremiumSheetCheckoutContext,
  persistPremiumSheetPendingSession,
  readPremiumSheetCheckoutContext,
  readPremiumSheetPendingSession,
} from "@/lib/premium-sheet/checkout-context-storage"
import { PREMIUM_FEATURES, type PremiumSheetContext } from "@/lib/premium-sheet/context"
import { premiumSheetDismissLabel } from "@/lib/premium-sheet/dismiss-label"
import { orderedBenefits } from "@/lib/premium-sheet/ordered-benefits"
import {
  premiumSheetPlan,
  premiumSheetPlans,
  PREMIUM_SHEET_DEFAULT_INTERVAL,
  PREMIUM_SHEET_RECOMMENDED_BADGE,
} from "@/lib/premium-sheet/pricing"
import {
  PREMIUM_SHEET_PURCHASE_COPY,
  premiumSheetPurchaseFailureCopy,
} from "@/lib/premium-sheet/purchase-copy"
import { premiumSheetPollDelayMs } from "@/lib/premium-sheet/purchase-poll"
import {
  initialPremiumSheetPurchaseState,
  isPremiumSheetPlanSelectionActive,
  isPremiumSheetPurchaseTerminal,
  premiumSheetPollableSessionId,
  premiumSheetPurchaseReducer,
  premiumSheetShowsCheckout,
  type PremiumSheetPurchaseFailure,
} from "@/lib/premium-sheet/purchase-state"
import { cn } from "@/lib/utils"
import { useToast } from "@/providers/toast-provider"

/**
 * The Premium sheet (T13, freemium-scanner-first PR4) — the program's one conversion
 * surface. It replaces T5's stub in place: same opener contract (`open` / `context` /
 * `onClose`), so every gate that already opens it — the scan verdict (T9), the trigger
 * cards (T10), the gated „Beispiel" pages (T12) — is untouched.
 *
 * Three things, in this order:
 *  1. what the user just bumped into, explained — `orderedBenefits` puts that feature
 *     first (plum, the repo's selected/accent colour) and fills the other two slots from
 *     the core order, so the sheet never reads as a single-feature paywall;
 *  2. the three plans at standard-catalog prices (`@/lib/premium-sheet/pricing` — never
 *     the launch catalog, whatever the launch-pricing flag says), Jährlich preselected;
 *  3. one coral CTA, and an escape that is always one tap away. Declining costs nothing:
 *     the free scanner keeps working exactly as before.
 *
 * **T14 — contextual purchase completion.** The CTA no longer dismisses: it swaps the
 * sheet's body for Stripe embedded checkout, in place. The whole purchase happens inside
 * this component, which is why the opener contract still does not change — no navigation,
 * no `/welcome`, no lost scan state.
 *
 * What this component may and may not conclude:
 *  - Stripe's `onComplete` moves it to „prüfen", never to unlocked. Only
 *    `POST /api/freemium/purchase/complete` — which re-reads the Session from Stripe —
 *    unlocks anything. The state machine (`lib/premium-sheet/purchase-state.ts`) makes that
 *    the only reachable path.
 *  - On unlock it refreshes the router, tells the opener (`onUnlocked`) and closes. The
 *    gates are server-rendered from the entitlement tier, so the refresh is what turns the
 *    „Beispiel" frame into the buyer's real content — but a surface that holds its own
 *    client-side tier state (the scanner's Merken bookmark) cannot learn from a refresh,
 *    which is why the callback exists (fix round 1, F1).
 *  - Every failure lands back on the plan rows inside the same open sheet. Nothing is
 *    navigated and nothing about the free session is touched.
 */
export function PremiumSheet({
  open,
  context,
  onClose,
  onUnlocked,
  onRequestOpen,
}: {
  open: boolean
  context: PremiumSheetContext | null
  onClose: () => void
  /**
   * Fired once, on VERIFIED unlock, before the router refresh. The opener uses it to flip
   * whatever tier state it holds itself — `router.refresh()` re-serves the server props of
   * a mounted client component but cannot touch its reducer, so without this the gate the
   * purchase started from stays locked until a hard reload (fix round 1, F1).
   */
  onUnlocked?: () => void
  /**
   * Asks the opener to open the sheet. Used only by the redirect return (PayPal), where
   * the buyer comes back on a fresh page load with the sheet closed: a pending or failed
   * payment must be visible, not silently dispatched into a closed sheet (fix round 1,
   * F2). Carries the context the purchase started from, so the reopened sheet is the gate
   * they left, not the surface's default.
   */
  onRequestOpen?: (context: PremiumSheetContext | null) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { toast } = useToast()
  const [purchase, dispatchPurchase] = useReducer(
    premiumSheetPurchaseReducer,
    initialPremiumSheetPurchaseState,
  )
  // BottomSheetContent keeps rendering through the ~200-250ms exit animation
  // (see bottom-sheet.tsx `closing`), but openers null out `context` the moment
  // they set `open` to false. Hold the last non-null context in state so the
  // benefit order, plum accent and escape label stay put while the sheet
  // animates out instead of flipping mid-exit (T13 fix round 1, F1). Adjusting
  // state during render (not a ref) keeps this compatible with the
  // react-hooks/refs rule, which forbids reading/writing refs during render.
  const [heldContext, setHeldContext] = useState<PremiumSheetContext | null>(context)
  if (context !== null && context !== heldContext) setHeldContext(context)
  const renderedContext = context ?? heldContext

  const benefits = orderedBenefits(renderedContext)
  const plans = premiumSheetPlans()
  const { selectedInterval, selectPlan } = usePlanSelection({
    defaultInterval: PREMIUM_SHEET_DEFAULT_INTERVAL,
  })
  const selectedPlan = premiumSheetPlan(selectedInterval)
  const dismissLabel = premiumSheetDismissLabel(renderedContext)
  const returnPath = sanitizeFreemiumCheckoutReturnPath(pathname)
  const planSelectionActive = isPremiumSheetPlanSelectionActive(purchase)
  const showsCheckout = premiumSheetShowsCheckout(purchase)

  /**
   * Verification. The only path to an unlocked state — and the only place the server is
   * asked whether money actually moved.
   *
   * `silentOnError` is what makes polling safe: a network blip on poll 3 must not demote a
   * paid `pending` purchase to a failure screen. A verdict the SERVER gave (`failed`) always
   * applies; an error on our side only ends the first, user-initiated attempt.
   *
   * `treatErrorAsPending` is the RESUME lane's variant (Codex fix wave round 2, R1): a
   * resumed purchase is not a fresh, user-initiated attempt, so a transport/5xx error here
   * must not read as the server's own "we could not confirm your payment" — it moves the
   * machine to `pending` instead, the same phase a genuine async settlement reaches, so the
   * poll below keeps trying and the resume handle (`clearPremiumSheetCheckoutMemo` only runs
   * on a TERMINAL phase) survives.
   *
   * Returns whether the call settled normally or was rate-limited, so pollers can surface a
   * brief notice instead of silently swallowing a 429 (Codex fix wave round 2, R3).
   */
  const verify = useCallback(
    async (
      sessionId: string,
      options: { silentOnError?: boolean; treatErrorAsPending?: boolean } = {},
    ): Promise<"settled" | "rate_limited"> => {
      type CompletionPayload = {
        status?: unknown
        routineReady?: unknown
        retryable?: unknown
        reason?: unknown
      } | null
      let payload: CompletionPayload = null
      let rateLimited = false
      try {
        const response = await fetch("/api/freemium/purchase/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        })
        if (response.status === 429) {
          rateLimited = true
        } else {
          payload = (await response.json().catch(() => null)) as CompletionPayload
          if (!response.ok) payload = null
        }
      } catch {
        payload = null
      }
      if (payload?.status === "complete") {
        dispatchPurchase({
          type: "verification_complete",
          sessionId,
          routineReady: payload.routineReady === true,
        })
        return "settled"
      }
      if (payload?.status === "provisioning") {
        // Paid and entitled, plan not built. `retryable: false` stops the poll.
        dispatchPurchase({
          type: "verification_provisioning",
          sessionId,
          retryable: payload.retryable !== false,
        })
        return "settled"
      }
      if (payload?.status === "pending") {
        dispatchPurchase({ type: "verification_pending", sessionId })
        return "settled"
      }
      if (payload?.status === "failed") {
        dispatchPurchase({
          type: "verification_failed",
          sessionId,
          reason: verificationFailureReason(payload.reason),
        })
        return "settled"
      }
      if (rateLimited) {
        // Never an authoritative verdict, from any phase this is called from (a fresh
        // attempt, the resume lane, a poll, or a manual recheck) — always parks the purchase
        // at `pending` so the poll or the next manual tap can retry it, instead of leaving a
        // first-attempt call stuck in `verifying` with no dispatch at all (Codex fix wave
        // round 2, R3).
        dispatchPurchase({ type: "verification_pending", sessionId })
        return "rate_limited"
      }
      if (options.treatErrorAsPending) {
        dispatchPurchase({ type: "verification_pending", sessionId })
        return "settled"
      }
      if (options.silentOnError) return "settled"
      dispatchPurchase({ type: "verification_failed", sessionId, reason: "verification_failed" })
      return "settled"
    },
    [dispatchPurchase],
  )

  // Set only by the RESUME lane below, to the exact Session id it resumed — the one case
  // where the first verify call is not the buyer's first, user-initiated attempt (R1).
  const resumedVerificationSessionRef = useRef<string | null>(null)
  const verifyingSessionId = purchase.phase === "verifying" ? purchase.sessionId : null
  useEffect(() => {
    if (!verifyingSessionId) return
    // Remembered BEFORE the request, for both lanes: a refresh mid-verification (the buyer
    // is impatient, the tab reloads, the redirect return already stripped the parameter)
    // would otherwise lose the only handle on the Session (Codex fix wave, Y3).
    persistPremiumSheetPendingSession(verifyingSessionId)
    const isResume = resumedVerificationSessionRef.current === verifyingSessionId
    void verify(verifyingSessionId, isResume ? { treatErrorAsPending: true } : undefined)
  }, [verifyingSessionId, verify])

  /**
   * The contextual return for redirect-based payment methods (PayPal above all). Stripe
   * navigates back to the ORIGINATING surface — never `/welcome` — carrying the Session id,
   * and this sheet, which is mounted on every gate, picks it up and finishes exactly the
   * same verification the in-place completion runs.
   */
  const consumedReturnRef = useRef<string | null>(null)
  const returnedContextRef = useRef<PremiumSheetContext | null>(null)
  const returnedRef = useRef(false)
  const resumeCheckedRef = useRef(false)
  useEffect(() => {
    // Read from `window.location` rather than `useSearchParams`: this component is mounted
    // on every gate, and `useSearchParams` would force a Suspense boundary (and a client
    // bailout) onto all of them for a parameter that only ever exists on a redirect return.
    if (typeof window === "undefined") return
    const returnedSessionId = new URLSearchParams(window.location.search).get(
      FREEMIUM_CHECKOUT_RETURN_PARAM,
    )
    if (returnedSessionId) {
      if (consumedReturnRef.current === returnedSessionId) return
      consumedReturnRef.current = returnedSessionId
      returnedRef.current = true
      // READ, not consume (Codex fix wave, Y3). The memo is dropped only once the purchase
      // reaches a terminal outcome — clearing it here meant a refresh while the payment was
      // still settling reopened the sheet on the surface's default gate, or not at all.
      returnedContextRef.current = readPremiumSheetCheckoutContext()
      persistPremiumSheetPendingSession(returnedSessionId)
      dispatchPurchase({ type: "provider_completed", sessionId: returnedSessionId })
      // Drop the parameter so a refresh (or a shared link) cannot replay the return.
      router.replace(pathname ?? returnPath)
      return
    }

    // No parameter: this may still be a reload DURING an unsettled payment, whose parameter
    // the first return already stripped. `sessionStorage` is then the only handle left, and
    // resuming from it is what keeps a pending verification alive across a refresh.
    if (resumeCheckedRef.current) return
    resumeCheckedRef.current = true
    const resumedSessionId = readPremiumSheetPendingSession()
    if (!resumedSessionId) return
    returnedRef.current = true
    returnedContextRef.current = readPremiumSheetCheckoutContext()
    // Marks this Session as a RESUME for the verifying effect above (R1): its first verify
    // call is not a fresh attempt, so a transport error must not fail it outright.
    resumedVerificationSessionRef.current = resumedSessionId
    dispatchPurchase({ type: "provider_completed", sessionId: resumedSessionId })
  }, [router, pathname, returnPath])

  /**
   * The redirect return's visible half (fix round 1, F2). The buyer came back on a fresh
   * page load, so the sheet is CLOSED: a `pending` panel or a `failed` alert would render
   * into nothing. Ask the opener to open it for every outcome that has something to say — a
   * verified completion needs no sheet, it unlocks the surface and toasts.
   */
  const reopenForPhase =
    purchase.phase === "pending" || purchase.phase === "failed" || purchase.phase === "provisioning"
      ? purchase.phase
      : null
  const reopenRequestedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!reopenForPhase || !returnedRef.current) return
    if (reopenRequestedRef.current === reopenForPhase) return
    reopenRequestedRef.current = reopenForPhase
    onRequestOpen?.(returnedContextRef.current)
  }, [reopenForPhase, onRequestOpen])

  /**
   * The poll (Codex fix wave, Y3). A `pending` payment and a retryable `provisioning`
   * failure are both finished somewhere else — in the webhook lane, seconds to minutes
   * later. Before this the sheet asked once and then sat there: a buyer whose payment
   * settled while the sheet was still mounted stayed gated until they reloaded the page.
   *
   * Bounded by `premiumSheetPollDelayMs`; when the schedule runs out the „Status prüfen"
   * button below is the way on, so the buyer is never left with nothing to press.
   *
   * Self-scheduling (Codex fix wave round 2, R3): each attempt is timed only from the moment
   * the PREVIOUS one settles, not from when it was fired. The earlier version drove this off
   * a `{sessionId, attempt}` state pair — bumping `attempt` re-ran the effect and armed the
   * next timer in the same tick as the in-flight `fetch`, so a slow response and the
   * following poll's own call could overlap. A plain closure loop inside one effect removes
   * the extra render round-trip entirely.
   */
  const pollableSessionId = premiumSheetPollableSessionId(purchase)
  const [rechecking, setRechecking] = useState(false)
  // Keyed to the Session it was raised for, and DERIVED against the current one below —
  // rather than reset imperatively at the top of the poll effect (a synchronous `setState`
  // in an effect body, which cascades an extra render for every purchase and trips
  // `react-hooks/set-state-in-effect`). A later purchase simply carries a different
  // `pollableSessionId`, so a stale notice from an earlier one stops rendering on its own.
  const [rateLimitState, setRateLimitState] = useState<{ sessionId: string; notice: boolean }>({
    sessionId: "",
    notice: false,
  })
  const rateLimitNotice = rateLimitState.sessionId === pollableSessionId && rateLimitState.notice
  useEffect(() => {
    if (!pollableSessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (attempt: number) => {
      const delayMs = premiumSheetPollDelayMs(attempt)
      if (delayMs === null) return
      timer = setTimeout(() => {
        void verify(pollableSessionId, { silentOnError: true }).then((outcome) => {
          if (cancelled) return
          setRateLimitState({ sessionId: pollableSessionId, notice: outcome === "rate_limited" })
          schedule(attempt + 1)
        })
      }, delayMs)
    }
    schedule(0)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pollableSessionId, verify])

  const recheck = useCallback(() => {
    if (!pollableSessionId || rechecking) return
    setRechecking(true)
    // A single immediate check. It does not touch the automatic schedule above in any way —
    // no attempt counter to reset, no new timer armed — so repeated taps can only ever have
    // one manual verify in flight at a time instead of stacking a second poll loop on top of
    // the running one (Codex fix wave round 2, R3).
    void verify(pollableSessionId, { silentOnError: true })
      .then((outcome) =>
        setRateLimitState({ sessionId: pollableSessionId, notice: outcome === "rate_limited" }),
      )
      .finally(() => setRechecking(false))
  }, [pollableSessionId, rechecking, verify])

  /**
   * The memo (remembered gate + resumable Session id) lives exactly as long as the purchase
   * can still change on its own, and is dropped the moment it cannot.
   */
  const purchaseIsTerminal = isPremiumSheetPurchaseTerminal(purchase)
  useEffect(() => {
    if (!purchaseIsTerminal) return
    clearPremiumSheetCheckoutMemo()
  }, [purchaseIsTerminal])

  /**
   * Paid, entitled, plan not built (Codex fix wave, Y1). The ACCESS half of the unlock is
   * true and is applied — client-held tier locks flip, the server-rendered gates refresh —
   * but the „Alles freigeschaltet" toast and the close are not: they belong to a purchase
   * whose content actually exists, and the sheet keeps saying so until it does.
   */
  const provisioningActive = purchase.phase === "provisioning"
  const accessAppliedRef = useRef(false)
  useEffect(() => {
    if (!provisioningActive || accessAppliedRef.current) return
    accessAppliedRef.current = true
    onUnlocked?.()
    router.refresh()
  }, [provisioningActive, onUnlocked, router])

  /**
   * Unlock: tell the opener (so client-held locks flip too — F1), refresh the
   * server-rendered gates so the originating surface shows the buyer's real content, raise
   * the toast, then close the sheet into it.
   *
   * The toast goes through the app-wide `ToastProvider`, which every surface that mounts
   * this sheet has above it in its route layout (`AppRouteProviders`). That provider
   * survives the refresh; a portal owned by this component does not, because the refresh
   * replaces the whole gated subtree this sheet lives in — which used to kill the toast a
   * few hundred ms in (fix round 1, F3).
   */
  const unlockedRoutineReady = purchase.phase === "unlocked" ? purchase.routineReady : null
  // Once, ever. Openers pass inline callbacks, so every re-render changes this effect's
  // deps — and `router.refresh()` itself causes one, which would make the unlock a refresh
  // loop raising a new toast each time.
  const unlockHandledRef = useRef(false)
  useEffect(() => {
    if (unlockedRoutineReady === null || unlockHandledRef.current) return
    unlockHandledRef.current = true
    onUnlocked?.()
    router.refresh()
    toast({
      title: PREMIUM_SHEET_PURCHASE_COPY.unlockToast,
      ...(unlockedRoutineReady
        ? {}
        : { description: PREMIUM_SHEET_PURCHASE_COPY.unlockToastRoutinePending }),
    })
    onClose()
  }, [unlockedRoutineReady, router, onClose, onUnlocked, toast])

  const startCheckout = useCallback(() => {
    // A fresh attempt owns the memo: any Session id left over from an abandoned one must not
    // be resumable, or a later mount would verify the wrong purchase.
    clearPremiumSheetCheckoutMemo()
    // Remembered for a redirect method only; a card payment never leaves this component.
    persistPremiumSheetCheckoutContext(renderedContext)
    dispatchPurchase({
      type: "checkout_requested",
      interval: selectedInterval,
      attemptId: crypto.randomUUID(),
    })
  }, [renderedContext, selectedInterval])

  // Every checkout callback names its attempt (Codex fix wave, Y5) — the reducer drops the
  // ones whose attempt the buyer has already replaced.
  const onCheckoutReady = useCallback(
    (attemptId: string) => dispatchPurchase({ type: "checkout_ready", attemptId }),
    [],
  )
  const onCheckoutFailed = useCallback(
    (attemptId: string) =>
      dispatchPurchase({ type: "checkout_failed", reason: "checkout_unavailable", attemptId }),
    [],
  )
  const onCheckoutCompleted = useCallback(
    (sessionId: string, attemptId: string) =>
      dispatchPurchase({ type: "provider_completed", sessionId, attemptId }),
    [],
  )
  const backToPlans = useCallback(() => dispatchPurchase({ type: "returned_to_plans" }), [])

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <BottomSheetContent
        className="max-h-[88dvh]"
        contentClassName="px-5 pb-5"
        header={
          <div className="px-5 pb-1 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-plum-dark)]">
              Chaarlie Premium
            </p>
            <BottomSheetTitle className="mt-1 text-[19px]">Alles für dein Haar.</BottomSheetTitle>
          </div>
        }
        footer={
          <div className="flex flex-col gap-1">
            {planSelectionActive ? (
              <Button
                variant="cta"
                className="w-full"
                data-premium-sheet-cta="true"
                data-premium-sheet-selected-interval={selectedInterval}
                onClick={startCheckout}
              >
                {/* After a failure the CTA is a retry, not a fresh offer — the repo-wide
                    „Erneut versuchen" (fix round 1, F2). */}
                {purchase.phase === "failed"
                  ? PREMIUM_SHEET_PURCHASE_COPY.retry
                  : selectedPlan.ctaLabel}
              </Button>
            ) : null}
            {/* One escape, always present and always one tap away — including mid-payment,
                where it returns to the plan rows instead of closing the sheet. */}
            <button
              type="button"
              data-premium-sheet-dismiss="true"
              onClick={showsCheckout ? backToPlans : onClose}
              className="min-h-[44px] w-full text-[13px] font-semibold text-muted-foreground"
            >
              {showsCheckout ? PREMIUM_SHEET_PURCHASE_COPY.backToPlans : dismissLabel}
            </button>
          </div>
        }
      >
        {/* The payment step replaces the sheet's BODY, never the sheet: the header, the
            escape and the buyer's place in the app all stay exactly where they were. */}
        {purchase.phase === "starting" || purchase.phase === "paying" ? (
          <PremiumSheetCheckout
            interval={purchase.interval}
            attemptId={purchase.attemptId}
            returnPath={returnPath}
            onReady={onCheckoutReady}
            onFailed={onCheckoutFailed}
            onCompleted={onCheckoutCompleted}
          />
        ) : purchase.phase === "verifying" ? (
          <p
            data-premium-sheet-purchase-phase="verifying"
            aria-live="polite"
            className="py-10 text-center text-sm font-semibold text-[var(--brand-plum-darkest)]"
          >
            {PREMIUM_SHEET_PURCHASE_COPY.verifying}
          </p>
        ) : purchase.phase === "pending" || purchase.phase === "provisioning" ? (
          <div
            data-premium-sheet-purchase-phase={purchase.phase}
            aria-live="polite"
            className="rounded-[14px] bg-[var(--brand-plum-ice)] px-4 py-5 text-center"
          >
            <p className="text-sm font-bold text-[var(--brand-plum-darkest)]">
              {purchase.phase === "pending"
                ? PREMIUM_SHEET_PURCHASE_COPY.pendingTitle
                : PREMIUM_SHEET_PURCHASE_COPY.provisioningTitle}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
              {purchase.phase === "pending"
                ? PREMIUM_SHEET_PURCHASE_COPY.pendingBody
                : purchase.retryable
                  ? PREMIUM_SHEET_PURCHASE_COPY.provisioningBody
                  : PREMIUM_SHEET_PURCHASE_COPY.provisioningStalledBody}
            </p>
            {/* The manual way on, always available — the automatic poll is bounded, and a
                buyer watching a spinner must never be left with nothing to press. */}
            {pollableSessionId ? (
              <button
                type="button"
                data-premium-sheet-recheck="true"
                onClick={recheck}
                disabled={rechecking}
                className="mt-3 min-h-[44px] w-full text-[13px] font-semibold text-[var(--brand-plum-dark)] disabled:opacity-60"
              >
                {rechecking
                  ? PREMIUM_SHEET_PURCHASE_COPY.verifying
                  : PREMIUM_SHEET_PURCHASE_COPY.recheck}
              </button>
            ) : null}
            {/* Non-terminal: the endpoint is rate-limited (20/min), not refusing the
                purchase — the schedule (or the next manual tap) tries again on its own
                (Codex fix wave round 2, R3). */}
            {rateLimitNotice ? (
              <p
                data-premium-sheet-rate-limit-notice="true"
                className="mt-2 text-[11px] text-muted-foreground"
              >
                {PREMIUM_SHEET_PURCHASE_COPY.rateLimited}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {purchase.phase === "failed" ? (
              <div
                data-premium-sheet-purchase-phase="failed"
                role="alert"
                className="mb-3 rounded-[12px] border border-destructive/30 bg-destructive/10 px-3 py-2"
              >
                <p className="text-[13px] font-semibold text-destructive">
                  {premiumSheetPurchaseFailureCopy(purchase.reason)}
                </p>
              </div>
            ) : null}
            {/* One tinted block for what the user just tapped, two quiet rows behind it —
                the sheet has enough boxes with the plan rows below. */}
            <ul className="flex flex-col">
              {benefits.map((featureId, index) => {
                const feature = PREMIUM_FEATURES[featureId]
                const accented = index === 0
                return (
                  <li
                    key={featureId}
                    data-premium-sheet-benefit={featureId}
                    data-premium-sheet-benefit-accent={accented ? "true" : "false"}
                    className={cn(
                      "px-3 py-2.5",
                      accented
                        ? "rounded-[12px] bg-[var(--brand-plum-ice)]"
                        : "border-b border-border last:border-b-0",
                    )}
                  >
                    <p
                      className={cn(
                        "text-sm font-bold",
                        accented ? "text-[var(--brand-plum-darkest)]" : "text-foreground",
                      )}
                    >
                      {feature.name}
                    </p>
                    <BottomSheetDescription className="mt-0.5 leading-snug">
                      {feature.benefit}
                    </BottomSheetDescription>
                  </li>
                )
              })}
            </ul>

            <div className="mt-4 grid gap-2" data-premium-sheet-plans="true">
              {plans.map((plan) => {
                const isSelected = plan.interval === selectedInterval
                return (
                  <button
                    key={plan.interval}
                    type="button"
                    aria-pressed={isSelected}
                    data-premium-sheet-plan={plan.interval}
                    data-premium-sheet-plan-selected={isSelected ? "true" : "false"}
                    onClick={() => selectPlan(plan.interval)}
                    className={cn(
                      "relative flex min-h-[60px] items-center gap-3 rounded-[14px] border bg-card px-4 py-3 text-left transition-colors",
                      isSelected
                        ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
                        : "border-border",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-[18px] shrink-0 place-items-center rounded-full border-2",
                        isSelected
                          ? "border-[var(--brand-plum)] bg-[var(--brand-plum)]"
                          : "border-border bg-background",
                      )}
                    >
                      {isSelected ? <span className="size-1.5 rounded-full bg-white" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-[var(--brand-plum-darkest)]">
                        {plan.name}
                        {plan.recommended ? (
                          <span className="ml-2 rounded-full bg-[var(--brand-plum)] px-2 py-0.5 align-middle font-mono text-[8px] font-semibold uppercase tracking-[0.08em] text-white">
                            {PREMIUM_SHEET_RECOMMENDED_BADGE}
                          </span>
                        ) : null}
                      </span>
                      {plan.detail ? (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {plan.detail}
                        </span>
                      ) : null}
                    </span>
                    <span
                      data-premium-sheet-plan-price={plan.interval}
                      className="shrink-0 text-[17px] font-bold leading-none text-[var(--brand-plum-darkest)]"
                    >
                      {plan.price}
                    </span>
                  </button>
                )
              })}
              <p className="mt-1 text-center text-[11px] text-[var(--text-caption)]">
                Jederzeit kündbar
              </p>
            </div>
          </>
        )}
      </BottomSheetContent>
    </BottomSheet>
  )
}

/**
 * The server's failure reason, narrowed to something the sheet can say in German (Codex fix
 * wave, Y4). Only the two lifecycle outcomes get their own line — a Session the buyer
 * abandoned and one that expired are different sentences, and both are different from „Wir
 * konnten deine Zahlung nicht bestätigen.", which is what every other reason falls back to.
 */
function verificationFailureReason(reason: unknown): PremiumSheetPurchaseFailure {
  if (reason === "checkout_session_expired") return "checkout_expired"
  if (reason === "checkout_session_abandoned") return "checkout_abandoned"
  return "verification_failed"
}
