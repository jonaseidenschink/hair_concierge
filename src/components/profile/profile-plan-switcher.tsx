"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { BillingInterval, MembershipManagementState } from "@/lib/billing/types"
import { intervalLabel, shouldRetainPlanChangeOperationId } from "@/lib/billing/plan-change"
import { STRIPE_PRICING_PLANS } from "@/lib/stripe/pricing-plans"

export function ProfilePlanSwitcher({
  state,
  onRefresh,
}: {
  state: MembershipManagementState
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<BillingInterval | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationIdRef = useRef<string | null>(null)

  if (state.kind === "pending" || state.kind === "reconciling") {
    return (
      <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
        {state.kind === "reconciling" ? (
          <>
            {state.retryable ? (
              <>
                Dein Wechsel konnte noch nicht vollständig mit {providerName(state.provider)}
                abgeglichen werden.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-3"
                  disabled={loading}
                  onClick={() => retryPlanChange(state)}
                >
                  {loading ? "Wird abgeglichen…" : "Erneut abgleichen"}
                </Button>
              </>
            ) : (
              <>
                Dein Wechsel wird gerade mit {providerName(state.provider)} abgeglichen. Du musst
                nichts weiter tun.
              </>
            )}
            {error ? <span className="mt-2 block text-destructive">{error}</span> : null}
          </>
        ) : (
          <>
            {state.approvalUrl ? (
              <>
                Dein Wechsel zu <strong>{intervalLabel(state.targetInterval)}</strong> wartet noch
                auf deine Bestätigung bei PayPal.
                <Button
                  type="button"
                  size="sm"
                  className="ml-3"
                  onClick={() => window.location.assign(state.approvalUrl!)}
                >
                  Bei PayPal bestätigen
                </Button>
              </>
            ) : (
              <>
                Wechsel zu <strong>{intervalLabel(state.targetInterval)}</strong> am{" "}
                <strong>{new Date(state.effectiveAt).toLocaleDateString("de-DE")}</strong>{" "}
                vorgemerkt.
              </>
            )}
          </>
        )}
      </div>
    )
  }

  if (state.kind !== "manageable") return null
  const currentInterval = state.currentInterval

  async function retryPlanChange(
    reconciliation: Extract<MembershipManagementState, { kind: "reconciling" }>,
  ) {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetInterval: reconciliation.targetInterval,
          operationId: reconciliation.operationId,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
        message?: string
      }
      if (!response.ok) {
        if (body.error === "plan_change_failed") {
          onRefresh()
          return
        }
        throw new Error(body.message ?? "Der Abgleich konnte noch nicht abgeschlossen werden.")
      }
      onRefresh()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Der Abgleich konnte nicht abgeschlossen werden.",
      )
    } finally {
      setLoading(false)
    }
  }

  async function confirmChange() {
    if (!target || target === currentInterval) return
    operationIdRef.current ??= crypto.randomUUID()
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetInterval: target, operationId: operationIdRef.current }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        approvalUrl?: string
        status?: string
        error?: string
        message?: string
      }
      if (!response.ok) {
        if (body.error === "plan_change_failed") operationIdRef.current = null
        throw new Error(body.message ?? "Der Wechsel konnte nicht gespeichert werden.")
      }
      if (body.approvalUrl) {
        window.location.assign(body.approvalUrl)
        return
      }
      if (!shouldRetainPlanChangeOperationId(body.status)) operationIdRef.current = null
      setOpen(false)
      onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bitte versuche es später erneut.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <Button type="button" variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? "Planauswahl schließen" : "Plan ändern"}
      </Button>
      {open ? (
        <div className="mt-4 max-w-lg">
          <p className="mb-3 text-sm text-muted-foreground">
            Der neue Plan beginnt erst bei deiner nächsten Verlängerung. Bis dahin bleibt alles
            unverändert und es gibt keine anteilige Abrechnung.
          </p>
          <div className="grid gap-2">
            {STRIPE_PRICING_PLANS.map((plan) => {
              const current = plan.interval === currentInterval
              const selected = plan.interval === target
              return (
                <button
                  key={plan.interval}
                  type="button"
                  disabled={current || loading}
                  aria-pressed={selected}
                  onClick={() => {
                    setTarget(plan.interval)
                    operationIdRef.current = null
                    setError(null)
                  }}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-semibold">{plan.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {current ? "Aktueller Plan" : plan.perMonth}
                    </span>
                  </span>
                  <span className="text-sm font-semibold">{plan.price}</span>
                </button>
              )
            })}
          </div>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          <Button
            type="button"
            className="mt-4"
            disabled={!target || target === currentInterval || loading}
            onClick={confirmChange}
          >
            {loading
              ? "Wird vorbereitet…"
              : target
                ? `Wechsel zu ${intervalLabel(target)} vormerken`
                : "Neuen Plan auswählen"}
          </Button>
          {state.provider === "paypal" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              PayPal bittet dich anschließend, den Wechsel kurz zu bestätigen.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function providerName(provider: "stripe" | "paypal") {
  return provider === "stripe" ? "Stripe" : "PayPal"
}
