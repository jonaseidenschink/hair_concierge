"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import type { PremiumSheetContext } from "@/lib/premium-sheet/context"
import { routineAnalytics } from "@/lib/personal-plan/routine/analytics"
import { CATEGORY_ROLE_POLICIES } from "@/lib/personal-plan/products/authorities"
import type {
  PersonalPlanRoutineView,
  RoutinePayloadV1,
  RoutineProposalDeltaV1,
} from "@/lib/personal-plan/routine/contracts"
import type {
  RoutineEditOperation,
  RoutineProductRef,
} from "@/lib/personal-plan/routine-candidate-compiler"
import type { RoutineProductDetail as RoutineProductDetailData } from "@/lib/personal-plan/routine/product-detail-service"
import { PRODUCT_FREQUENCIES } from "@/lib/vocabulary/frequencies"
import { reportPersonalPlanTransitionTiming } from "@/lib/personal-plan/transition-performance"
import { markPersonalPlanStageNavigation } from "@/lib/personal-plan/stage-navigation-intent"
import type { PortfolioPresentation } from "@/lib/personal-plan/routine/portfolio-presentation"
import {
  hasRoutinePlanUpdatedSignal,
  withoutRoutinePlanUpdatedSignal,
} from "@/lib/personal-plan/routine/plan-updated-signal"

import { requestRoutineAttentionRefresh } from "./routine-attention-indicator"
import { RoutineEditor, type RoutineProductOption } from "./routine-editor"
import { routineCategoryLabel, routinePurposeLabel } from "./routine-item-card"
import { RoutinePage } from "./routine-page"
import { RoutineProductDetail } from "./routine-product-detail"
import { RoutineProposalSheet, type RoutineProposalSheetDeltaEntry } from "./routine-proposal-sheet"
import type { RoutineRefinementBannerViewModel } from "./routine-refinement-banner"

type RoutineViewResponse = PersonalPlanRoutineView | { status: "no_personal_plan" }
type Mode = "overview" | "editor"

/**
 * T17: the gate a lapsed owner opens from their own Routine. Same `{feature, source}`
 * pair the T12 „Beispiel" Routine uses (`GATED_EXAMPLE_COPY.routine`), so the sheet
 * orders its benefits the same way from either surface.
 */
const KEEPSAKE_ROUTINE_GATE = { feature: "routine", source: "gated:routine" } as const

function readError(response: Response, fallback: string) {
  return response
    .json()
    .then((body: { error?: unknown }) => (typeof body.error === "string" ? body.error : fallback))
    .catch(() => fallback)
}

export function friendlyError(error: string, fallback: string) {
  if (
    [
      "stale_active_version",
      "stale_proposal",
      "revision_conflict",
      "source_revision_conflict",
      "stale_source",
    ].includes(error)
  ) {
    return "Deine Routine hat sich inzwischen geändert. Wir haben den aktuellen Stand neu geladen."
  }
  if (error === "unauthorized" || error === "forbidden") {
    return "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an."
  }
  if (error === "temporarily_unavailable") return fallback
  // API error values are server tokens, not copy. Keep unknown values out of
  // the UI even when they do not contain an underscore (for example
  // "unauthorized").
  return fallback
}

function countBand(count: number): "0" | "1" | "2_4" | "5_plus" {
  if (count <= 0) return "0"
  if (count === 1) return "1"
  if (count <= 4) return "2_4"
  return "5_plus"
}

export type ProposalReloadClassification = "resolved" | "same_pending" | "superseded"

export function classifyProposalReload(
  view: PersonalPlanRoutineView,
  attemptedProposalId: string,
): ProposalReloadClassification {
  if (view.pendingProposal?.id === attemptedProposalId) return "same_pending"
  if (view.pendingProposal) return "superseded"
  return "resolved"
}

export type RoutineSyncKickResponse = { proposalStaged?: unknown; recomputeApplied?: unknown }

/**
 * Entry-sync reload gate. A staged successor proposal is not the only
 * user-visible result any more: a module-driven Feinschliff recompute that
 * healed during this sync is already ACTIVE (auto-confirmed), so it leaves
 * `proposalStaged` false while the rendered Routine is stale. Reload on either.
 */
export function routineSyncReloadOutcome(result: RoutineSyncKickResponse): {
  reload: boolean
  outcome: "proposal_staged" | "recompute_applied" | "unchanged"
} {
  if (result.proposalStaged === true) return { reload: true, outcome: "proposal_staged" }
  if (result.recomputeApplied === true) return { reload: true, outcome: "recompute_applied" }
  return { reload: false, outcome: "unchanged" }
}

export function refreshRouteAfterRoutineAcceptance({
  action,
  refresh,
}: {
  action: "accept" | "reject"
  refresh: () => void
}) {
  if (action === "accept") refresh()
}

export function initialRoutineProposalSheetOpen(view: PersonalPlanRoutineView): boolean {
  void view
  return false
}

function editorSeed(view: PersonalPlanRoutineView): RoutinePayloadV1 | null {
  return view.activeVersion?.payload ?? view.pendingProposal?.candidate ?? null
}

function frozenProductOptions(
  payload: RoutinePayloadV1 | null,
): Record<string, RoutineProductOption[]> {
  if (!payload) return {}
  const choicesByCategory = new Map<string, RoutineProductOption[]>()
  for (const category of payload.intent.categories) {
    for (const assignment of category.assignments) {
      const productRef = assignment.productRef as RoutineProductRef
      if (productRef.kind === "none") continue
      const item = payload.items.find(
        (candidate) => candidate.assignmentKey === assignment.assignmentKey,
      )
      const label =
        item && typeof item.product.displayName === "string" && item.product.displayName.length > 0
          ? item.product.displayName
          : "Produkt ohne Namen"
      const choices = choicesByCategory.get(category.category) ?? []
      if (
        !choices.some((choice) => JSON.stringify(choice.productRef) === JSON.stringify(productRef))
      ) {
        choices.push({ label, productRef })
      }
      choicesByCategory.set(category.category, choices)
    }
  }
  return Object.fromEntries(
    payload.items.map((item) => [item.assignmentKey, choicesByCategory.get(item.category) ?? []]),
  )
}

function productDisplayName(item: RoutinePayloadV1["items"][number] | undefined) {
  const displayName = item?.product.displayName
  return typeof displayName === "string" && displayName.length > 0 ? displayName : null
}

export function routineProposalDeltaEntries(
  entries: RoutineProposalDeltaV1["direct"],
  active: RoutinePayloadV1 | null,
  candidate: RoutinePayloadV1,
): RoutineProposalSheetDeltaEntry[] {
  const activeItems = new Map(active?.items.map((item) => [item.itemKey, item]) ?? [])
  const candidateItems = new Map(candidate.items.map((item) => [item.itemKey, item]))
  return entries.map((entry, index) => {
    const raw = entry as { itemKey?: unknown; explanationKey?: unknown; kind?: unknown }
    const itemKey = typeof raw.itemKey === "string" ? raw.itemKey : ""
    const kind = typeof raw.kind === "string" ? raw.kind : "geändert"
    if (itemKey.startsWith("category:")) {
      const category = itemKey.slice("category:".length)
      const inclusion = candidate.intent.categories.find(
        (entry) => entry.category === category,
      )?.inclusion
      return {
        changeKey: `${itemKey}:${index}`,
        label: routineCategoryLabel(category),
        description:
          inclusion === "excluded" ? "Kategorie nicht mehr verwenden" : "Kategorie verwenden",
      }
    }

    const activeItem = activeItems.get(itemKey)
    const candidateItem = candidateItems.get(itemKey)
    const item = candidateItem ?? activeItem
    const productName = productDisplayName(item)
    const inclusionChanged = Boolean(
      activeItem && candidateItem && activeItem.state.inclusion !== candidateItem.state.inclusion,
    )
    const changeLabel =
      inclusionChanged && candidateItem?.state.inclusion === "excluded"
        ? "nicht mehr in Verwendung"
        : inclusionChanged && candidateItem?.state.inclusion === "included"
          ? "wird verwendet"
          : kind === "added"
            ? "hinzugefügt"
            : kind === "removed"
              ? "entfernt"
              : "geändert"
    return {
      changeKey: `${itemKey || "item"}:${index}`,
      label: item ? routinePurposeLabel(item.purposeKey) : "Routine-Baustein",
      description: productName ? `${productName} · ${changeLabel}` : changeLabel,
    }
  })
}

export function PersonalPlanRoutineClient({
  initialView,
  enabled,
  portfolioPresentation = null,
  initialRefinementBanner = null,
  merklisteEnabled = false,
  keepsake = false,
}: {
  initialView: PersonalPlanRoutineView
  enabled: boolean
  portfolioPresentation?: PortfolioPresentation | null
  initialRefinementBanner?: RoutineRefinementBannerViewModel | null
  /**
   * T16, fix round 1 (F1): server-derived freemium-flag gate for the shared „Gemerkt"
   * section (`GemerktSection`, rendered inside `RoutinePage`) — see that component's doc
   * comment. Defaults to `false` so an existing caller that forgets to pass it stays on
   * today's exact behavior.
   */
  merklisteEnabled?: boolean
  /**
   * T17 keepsake mode: this is a LAPSED owner reading their OWN confirmed Routine after
   * their access ended. The caller passes `enabled={false}`, which already disables the
   * entry sync, the editor and the proposal machinery; `keepsake` additionally
   *
   * - drops the per-item product-detail read (`GET /api/personal-plan/routine/items/…`
   *   is outside the freemium admission list and answers 403 for them — the cards render
   *   as plain rows instead of buttons that error),
   * - locks „Anpassen" to the Premium sheet instead of hiding it (the owner should see
   *   what they get back, not a silently reduced page), and
   * - renders „Gemerkt" read-only.
   *
   * Defaults to `false`: premium and flag-off render byte-identically to today.
   */
  keepsake?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [view, setView] = React.useState(initialView)
  // Task 2.6: the "✓ Plan aktualisiert" toast signal. Read once from the
  // arrival URL (a stripped reload never carries it again — see the effect
  // below) and never re-derived from a later `searchParams` change, so a
  // client-side navigation elsewhere on this page cannot resurrect it.
  const [showPlanUpdatedToast, setShowPlanUpdatedToast] = React.useState(() =>
    hasRoutinePlanUpdatedSignal(searchParams),
  )
  const planUpdatedSignalConsumed = React.useRef(false)
  React.useEffect(() => {
    if (planUpdatedSignalConsumed.current) return
    planUpdatedSignalConsumed.current = true
    if (!hasRoutinePlanUpdatedSignal(searchParams)) return
    // Strip the param immediately so a reload of this exact URL never
    // re-shows the toast (the signal is one-shot navigation state, not
    // persistent page state).
    router.replace(withoutRoutinePlanUpdatedSignal(pathname, searchParams), { scroll: false })
    // Deliberately mount-only: consume-once by design, so re-running this on
    // a later searchParams/pathname change must never re-arm it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dismissPlanUpdatedToast = React.useCallback(() => setShowPlanUpdatedToast(false), [])
  const [mode, setMode] = React.useState<Mode>("overview")
  // A successor proposal is intentionally non-blocking during the current
  // visit, but it must be presented again on the next Routine-page visit until
  // the owner explicitly accepts or rejects it.
  const [proposalOpen, setProposalOpen] = React.useState(
    initialRoutineProposalSheetOpen(initialView),
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Optimistic, session-local hide so the banner disappears immediately on
  // dismiss without waiting for a reload; the server write (which re-arms
  // the banner for whichever module becomes the next open one) happens
  // best-effort alongside it — write failures (e.g. pre-migration) are
  // tolerated silently, matching the lifecycle store's documented contract.
  const [bannerDismissedLocally, setBannerDismissedLocally] = React.useState(false)
  const dismissRefinementBanner = React.useCallback(() => {
    if (!initialRefinementBanner) return
    setBannerDismissedLocally(true)
    void fetch("/api/personal-plan/refinement-status/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: initialRefinementBanner.module }),
    }).catch(() => {
      // Best-effort: the banner stays hidden for this visit even if the
      // write fails; the next full page load reflects the server's state.
    })
  }, [initialRefinementBanner])
  const refineFromBanner = React.useCallback(() => {
    if (!initialRefinementBanner) return
    markPersonalPlanStageNavigation("/plan-start")
    router.push(`/plan-start?refine=${initialRefinementBanner.module}`)
  }, [router, initialRefinementBanner])
  const [proposalRetryId, setProposalRetryId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<RoutineProductDetailData | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)
  // T17 keepsake: the one gate this page can open. Same shape as `GatedPreview`'s and
  // T15's Profil opener. Never rendered outside keepsake mode.
  const [premiumSheetOpen, setPremiumSheetOpen] = React.useState(false)
  const [premiumSheetContext, setPremiumSheetContext] = React.useState<PremiumSheetContext | null>(
    null,
  )
  const openPremiumSheet = React.useCallback((context: PremiumSheetContext) => {
    setPremiumSheetContext(context)
    setPremiumSheetOpen(true)
  }, [])
  const openKeepsakeRoutineGate = React.useCallback(
    () => openPremiumSheet(KEEPSAKE_ROUTINE_GATE),
    [openPremiumSheet],
  )
  const syncedOnEntry = React.useRef(false)
  const displayedProposalId = React.useRef<string | null>(null)
  const proposalResolutionInFlight = React.useRef(false)
  const initialAnalyticsVariant = React.useRef<"active" | "proposal" | "empty">(
    initialView.pendingProposal && !initialView.activeVersion
      ? "proposal"
      : initialView.activeVersion
        ? "active"
        : "empty",
  )

  const reload = React.useCallback(async () => {
    const startedAt = performance.now()
    let outcome = "error"
    try {
      const response = await fetch("/api/personal-plan/routine", { cache: "no-store" })
      if (!response.ok)
        throw new Error(await readError(response, "Routine konnte nicht aktualisiert werden."))
      const next = (await response.json()) as RoutineViewResponse
      if (next.status === "no_personal_plan")
        throw new Error("Dein persönlicher Plan ist nicht verfügbar.")
      setView(next)
      requestRoutineAttentionRefresh(Boolean(next.pendingProposal))
      outcome = "ok"
      return next
    } finally {
      reportPersonalPlanTransitionTiming({
        layer: "client",
        operation: "routine_reload",
        outcome,
        durationMs: performance.now() - startedAt,
      })
    }
  }, [])

  const pending = view.pendingProposal
  const isInitial = Boolean(pending && !view.activeVersion)
  const seed = editorSeed(view)
  const canEdit = enabled && Boolean(seed)
  const refinementBanner = !bannerDismissedLocally ? initialRefinementBanner : null
  const entrySyncTiming = routineEntrySyncTiming({
    enabled,
    hasPendingProposal: Boolean(pending),
  })

  React.useEffect(() => {
    routineAnalytics.track("personal_plan_stage4_routine_viewed", {
      surface: "routine_page",
      variant: initialAnalyticsVariant.current,
    })
  }, [])

  const kickRoutineSync = React.useCallback(
    (restart = false) => {
      if (restart) syncedOnEntry.current = false
      if (!enabled || syncedOnEntry.current) return
      syncedOnEntry.current = true
      void (async () => {
        const startedAt = performance.now()
        let outcome = "error"
        try {
          const response = await fetch("/api/personal-plan/routine/sync", { method: "POST" })
          if (!response.ok) throw new Error(await readError(response, "temporarily_unavailable"))
          const sync = routineSyncReloadOutcome((await response.json()) as RoutineSyncKickResponse)
          if (sync.reload) {
            await reload()
            setProposalOpen(false)
          }
          outcome = sync.outcome
        } catch {
          routineAnalytics.track("personal_plan_stage4_outcome", {
            origin: "sync",
            outcome: "error",
          })
        } finally {
          reportPersonalPlanTransitionTiming({
            layer: "client",
            operation: "routine_entry_sync",
            outcome,
            durationMs: performance.now() - startedAt,
          })
        }
      })()
    },
    [enabled, reload],
  )

  React.useEffect(() => {
    if (entrySyncTiming === "after_render") kickRoutineSync()
  }, [entrySyncTiming, kickRoutineSync])

  React.useEffect(() => {
    if (!proposalOpen || !pending || displayedProposalId.current === pending.id) return
    displayedProposalId.current = pending.id
    routineAnalytics.track("personal_plan_stage4_proposal_interacted", {
      interaction: "displayed",
      origin: "routine_page",
      changeCountBand: countBand(pending.delta.direct.length + pending.delta.consequential.length),
    })
  }, [pending, proposalOpen])

  /**
   * PR5 review fix (Z3): the graduation hand-off. „Zur Routine hinzufügen" →
   * „Benutze ich schon" writes ownership and drops the product from „Gemerkt" — but the
   * visible Routine is compiled from the confirmed version, so before this fix the product
   * simply vanished with nothing to show for it.
   *
   * The hand-off now runs the EXISTING flows and nothing else — no implicit routine write
   * is added here:
   * 1. the routine sync (the same `POST /api/personal-plan/routine/sync` this page already
   *    kicks on entry), which is the queued path that can surface a change; the user sees
   *    an honest in-progress state while it runs,
   * 2. if it staged a proposal, the existing proposal sheet opens on it — where the change
   *    is reviewed and accepted, exactly as for any other successor,
   * 3. otherwise the truthful outcome: the product is saved as owned, the Routine has not
   *    changed, and „Routine anpassen" hands the user into the existing editor.
   */
  const [graduation, setGraduation] = React.useState<{
    name: string
    status: "pending" | "proposal" | "unchanged"
  } | null>(null)

  const handleGraduated = React.useCallback(
    (product: { productId: string; name: string }) => {
      setGraduation({ name: product.name, status: "pending" })
      void (async () => {
        try {
          // `enabled === false` means the successor machinery is off for this render
          // (Stage-4 flag off, or a keepsake read): the sync route would refuse it, so the
          // hand-off goes straight to its honest terminal state.
          if (enabled) {
            const response = await fetch("/api/personal-plan/routine/sync", { method: "POST" })
            if (!response.ok) throw new Error(await readError(response, "temporarily_unavailable"))
          }
          const next = await reload()
          if (next.pendingProposal) {
            setProposalOpen(true)
            setGraduation({ name: product.name, status: "proposal" })
            return
          }
          setGraduation({ name: product.name, status: "unchanged" })
        } catch {
          // The ownership write already succeeded — only the "did the Routine move?"
          // question is unanswered, so say the smaller, certain thing.
          setGraduation({ name: product.name, status: "unchanged" })
        }
      })()
    },
    [enabled, reload],
  )

  const openEditor = React.useCallback(() => {
    if (!canEdit) return
    setError(null)
    setMode("editor")
    routineAnalytics.track("personal_plan_stage4_editor_interacted", {
      interaction: "opened",
      origin: "routine_page",
    })
  }, [canEdit])

  const submitOperations = React.useCallback(
    async (operations: RoutineEditOperation[]) => {
      setBusy(true)
      setError(null)
      routineAnalytics.track("personal_plan_stage4_editor_interacted", {
        interaction: "submitted",
        origin: "routine_page",
        changeCountBand: countBand(operations.length),
      })
      try {
        const response = await fetch("/api/personal-plan/routine/proposals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: view.planRevision,
            expectedSourceRevision: view.sourceRevision,
            operations,
          }),
        })
        if (!response.ok) {
          const code = await readError(response, "temporarily_unavailable")
          throw new Error(friendlyError(code, "Änderungen konnten nicht geprüft werden."))
        }
        const next = await reload()
        setMode("overview")
        setProposalOpen(false)
        if (!next.pendingProposal) {
          routineAnalytics.track("personal_plan_stage4_outcome", {
            origin: "editor",
            outcome: "no_change",
          })
        }
      } catch (submissionError) {
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : "Änderungen konnten nicht geprüft werden.",
        )
        try {
          await reload()
        } catch {
          // The retained local operation batch remains retryable after a stale conflict.
        }
      } finally {
        setBusy(false)
      }
    },
    [reload, view.planRevision, view.sourceRevision],
  )

  const resolveProposal = React.useCallback(
    async (action: "accept" | "reject") => {
      if (!pending || busy || proposalResolutionInFlight.current) return
      proposalResolutionInFlight.current = true
      const attemptedProposalId = pending.id
      const retryMessage = "Deine Entscheidung konnte nicht gespeichert werden."
      const reconcileReload = (next: PersonalPlanRoutineView, message: string | null) => {
        const classification = classifyProposalReload(next, attemptedProposalId)
        if (classification === "resolved") {
          setProposalRetryId(null)
          setError(null)
          setProposalOpen(false)
          routineAnalytics.track("personal_plan_stage4_proposal_interacted", {
            interaction: action === "accept" ? "accepted" : "rejected",
            origin: "routine_page",
            changeCountBand: countBand(
              pending.delta.direct.length + pending.delta.consequential.length,
            ),
          })
          refreshRouteAfterRoutineAcceptance({
            action,
            refresh: () => router.refresh(),
          })
          kickRoutineSync(true)
          return
        }

        const currentProposalId = next.pendingProposal?.id ?? attemptedProposalId
        setProposalRetryId(currentProposalId)
        setProposalOpen(true)
        setError(
          classification === "superseded"
            ? "Deine Routine hat sich inzwischen geändert. Prüfe den aktuellen Vorschlag."
            : (message ?? retryMessage),
        )
      }

      setBusy(true)
      setError(null)
      setProposalRetryId(null)
      try {
        const response = await fetch(`/api/personal-plan/routine/proposals/${pending.id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, expectedRevision: view.planRevision }),
        })
        if (!response.ok) {
          const code = await readError(response, "temporarily_unavailable")
          throw new Error(
            friendlyError(code, "Deine Entscheidung konnte nicht gespeichert werden."),
          )
        }
        const next = await reload()
        reconcileReload(next, null)
      } catch (resolveError) {
        const message =
          resolveError instanceof Error &&
          [
            "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.",
            "Deine Routine hat sich inzwischen geändert. Wir haben den aktuellen Stand neu geladen.",
          ].includes(resolveError.message)
            ? resolveError.message
            : retryMessage
        try {
          const next = await reload()
          reconcileReload(next, message)
        } catch {
          setError(message)
          setProposalRetryId(attemptedProposalId)
          setProposalOpen(true)
        }
      } finally {
        proposalResolutionInFlight.current = false
        setBusy(false)
      }
    },
    [busy, kickRoutineSync, pending, reload, router, view.planRevision],
  )

  const openDetail = React.useCallback(async (item: RoutinePayloadV1["items"][number]) => {
    setError(null)
    try {
      const response = await fetch(
        `/api/personal-plan/routine/items/${encodeURIComponent(item.itemKey)}`,
        { cache: "no-store" },
      )
      if (!response.ok) throw new Error(await readError(response, "Produktdetail nicht verfügbar."))
      setDetail((await response.json()) as RoutineProductDetailData)
      setDetailOpen(true)
      routineAnalytics.track("personal_plan_stage4_item_interacted", {
        interaction: "product_detail_opened",
        surface: "routine_card",
      })
    } catch {
      setError("Das Produktdetail konnte gerade nicht geladen werden.")
    }
  }, [])

  if (mode === "editor" && seed) {
    return (
      <RoutineEditor
        routine={seed}
        productOptions={frozenProductOptions(seed)}
        supportedCadences={[...PRODUCT_FREQUENCIES]}
        supportedRolesByCategory={Object.fromEntries(
          Object.entries(CATEGORY_ROLE_POLICIES).map(([category, policy]) => [
            category,
            [...policy.allowedRoles],
          ]),
        )}
        isSubmitting={busy}
        retryMessage={error}
        onCancel={() => setMode("overview")}
        onSubmitOperations={submitOperations}
      />
    )
  }

  if (!seed && view.status === "authority_repair_required") {
    return <RoutinePage view={view} portfolioPresentation={portfolioPresentation} />
  }

  if (!seed) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-8">
        <section aria-live="polite" className="space-y-3 rounded-[8px] border border-border p-5">
          <h1 className="text-xl font-semibold">Deine Routine wird vorbereitet</h1>
          <p className="text-sm text-muted-foreground">
            Dein persönlicher Plan ist vorhanden, aber noch keine Routine kann sicher angezeigt
            werden. Bitte kehre später zurück.
          </p>
          <Button type="button" variant="outline" onClick={() => void reload()}>
            Erneut laden
          </Button>
        </section>
      </main>
    )
  }

  return (
    <>
      {error ? (
        <p
          className="mx-auto mt-4 w-full max-w-2xl rounded-[8px] border border-destructive/40 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {graduation ? (
        <section
          aria-live="polite"
          className="mx-auto mt-4 w-full max-w-2xl rounded-[12px] border border-border bg-card px-4 py-3"
        >
          <p className="text-sm text-foreground">
            {graduation.status === "pending"
              ? `${graduation.name} wird übernommen …`
              : graduation.status === "proposal"
                ? `${graduation.name} ist gespeichert. Prüfe den Vorschlag für deine Routine.`
                : `${graduation.name} ist als „benutze ich schon" gespeichert. In deiner Routine steht es noch nicht.`}
          </p>
          {graduation.status === "unchanged" && canEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-auto"
              onClick={openEditor}
            >
              Routine anpassen
            </Button>
          ) : null}
        </section>
      ) : null}
      <RoutinePage
        view={view}
        onEdit={canEdit ? openEditor : undefined}
        onLockedEdit={keepsake ? openKeepsakeRoutineGate : undefined}
        onReviewProposal={
          !isInitial && pending && enabled ? () => setProposalOpen(true) : undefined
        }
        onItemDetail={keepsake ? undefined : (item) => void openDetail(item)}
        merklisteReadOnly={keepsake}
        portfolioPresentation={portfolioPresentation}
        refinementBanner={refinementBanner}
        onDismissRefinementBanner={dismissRefinementBanner}
        onRefineFromBanner={refineFromBanner}
        showPlanUpdatedToast={showPlanUpdatedToast}
        onDismissPlanUpdatedToast={dismissPlanUpdatedToast}
        merklisteEnabled={merklisteEnabled}
        onGraduated={handleGraduated}
      />
      {pending ? (
        <RoutineProposalSheet
          open={proposalOpen}
          onOpenChange={(open) => {
            setProposalOpen(open)
            if (!open) {
              routineAnalytics.track("personal_plan_stage4_proposal_interacted", {
                interaction: "dismissed",
                origin: "routine_page",
                changeCountBand: countBand(
                  pending.delta.direct.length + pending.delta.consequential.length,
                ),
              })
            }
          }}
          variant={isInitial ? "initial" : "successor"}
          directChanges={routineProposalDeltaEntries(
            pending.delta.direct,
            view.activeVersion?.payload ?? null,
            pending.candidate,
          )}
          consequentialChanges={routineProposalDeltaEntries(
            pending.delta.consequential,
            view.activeVersion?.payload ?? null,
            pending.candidate,
          )}
          unchangedItemCount={pending.delta.unchangedItemCount}
          submitting={busy}
          retrying={proposalRetryId === pending.id}
          errorMessage={error}
          onAccept={() => void resolveProposal("accept")}
          onBackToEditor={canEdit ? openEditor : undefined}
          onDiscardCandidate={isInitial ? undefined : () => void resolveProposal("reject")}
          onDismissForVisit={() => setProposalOpen(false)}
        />
      ) : null}
      <BottomSheet open={detailOpen} onOpenChange={setDetailOpen}>
        <BottomSheetContent>
          <BottomSheetTitle>Produktdetail</BottomSheetTitle>
          <BottomSheetDescription>
            Eignung aus deiner bestätigten Routine und aktuelle Shopdaten.
          </BottomSheetDescription>
          {detail ? (
            <RoutineProductDetail
              item={detail.item}
              commerce={detail.commerce}
              fitStatusLabel={detail.fitStatusLabel}
              frozenFitSummary={detail.frozenFitSummary}
              limitationLabel={detail.limitationLabel}
              onOpenProduct={
                detail.commerce.productUrl
                  ? () => {
                      window.open(detail.commerce.productUrl!, "_blank", "noopener,noreferrer")
                      routineAnalytics.track("personal_plan_stage4_item_interacted", {
                        interaction: "shop_link_opened",
                        surface: "routine_detail",
                      })
                    }
                  : undefined
              }
            />
          ) : null}
        </BottomSheetContent>
      </BottomSheet>
      {keepsake ? (
        <PremiumSheet
          open={premiumSheetOpen}
          context={premiumSheetContext}
          onClose={() => {
            setPremiumSheetOpen(false)
            setPremiumSheetContext(null)
          }}
          // No `onUnlocked` copy to flip: this page's keepsake mode is a SERVER prop, so
          // the sheet's own `router.refresh()` after a verified purchase re-resolves it.
          onRequestOpen={(context) => openPremiumSheet(context ?? KEEPSAKE_ROUTINE_GATE)}
        />
      ) : null}
    </>
  )
}

export function routineEntrySyncTiming(input: {
  enabled: boolean
  hasPendingProposal: boolean
}): "disabled" | "after_render" | "after_proposal_resolution" {
  if (!input.enabled) return "disabled"
  return input.hasPendingProposal ? "after_proposal_resolution" : "after_render"
}
