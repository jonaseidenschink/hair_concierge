import type { BillingSubscriptionRow } from "./types"

export function formatBillingDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString("de-DE") : "—"
}

export function formatBillingMembershipStatus(
  subscription:
    | Pick<
        BillingSubscriptionRow,
        "entitlement_status" | "cancel_at_period_end" | "current_period_end"
      >
    | null
    | undefined,
  fallbackStatus?: string | null,
  now = new Date(),
): string {
  if (
    subscription?.entitlement_status === "canceled" &&
    subscription.cancel_at_period_end &&
    isFutureDate(subscription.current_period_end, now)
  ) {
    return `Verlängerung gekündigt, Zugang bis ${formatBillingDate(subscription.current_period_end)}`
  }

  const status = subscription?.entitlement_status ?? fallbackStatus
  switch (status) {
    case "active":
      return "Aktiv"
    case "past_due":
      return "Zahlung ausstehend"
    case "canceled":
      return "Gekündigt"
    case "incomplete":
      return "Unvollständig"
    default:
      return status ?? "—"
  }
}

function isFutureDate(value: string | null | undefined, now: Date): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > now.getTime()
}
