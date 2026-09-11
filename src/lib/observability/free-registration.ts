import * as Sentry from "@sentry/nextjs"

import type { ProvisionFreeInitialSnapshotResult } from "@/lib/personal-plan/persistence/free-snapshot-service"

/**
 * Free-tier snapshot provisioning telemetry (T18 fix round 1, review finding W2).
 *
 * The service signals most failures as TYPED, non-throwing outcomes
 * (`no_quiz_artifact`, `invalid_source`, `temporarily_unavailable`), so the
 * caller's `try/catch` never fired for them and nothing was logged: the user
 * landed on `/scan`, `/api/scan/resolve` answered `profile_missing`, and there
 * was no signal anywhere that the free product had failed for them. Every
 * outcome other than `provisioned` and `paid_user` (both expected, neither a
 * failure) is reported here.
 *
 * Follows `src/lib/observability/scan.ts`'s idiom — tags + a context object,
 * with an injectable sink so tests can assert what would be reported.
 */

export type FreeRegistrationProvisioningStage = "confirm" | "scan_retry"

export type FreeRegistrationProvisioningDetails = {
  stage: FreeRegistrationProvisioningStage
  outcome: string
  reasonCode?: string | null
  userId?: string | null
}

type ScopeLike = {
  setContext(name: string, context: Record<string, unknown>): void
  setLevel?(level: "warning" | "error"): void
  setTag(key: string, value: string): void
}

type Sink = {
  captureException(error: unknown): void
  withScope(callback: (scope: ScopeLike) => void): void
}

/**
 * `temporarily_unavailable` is a transient outage the `/scan` retry can still
 * recover from — a warning. `no_quiz_artifact` and `invalid_source` mean the
 * free product is broken for this account until someone looks, so they are
 * errors.
 */
export function resolveFreeProvisioningLevel(outcome: string): "warning" | "error" {
  return outcome === "temporarily_unavailable" ? "warning" : "error"
}

export function isFreeProvisioningFailure(result: ProvisionFreeInitialSnapshotResult): boolean {
  return result.outcome !== "provisioned" && result.outcome !== "paid_user"
}

export function buildFreeProvisioningPayload(details: FreeRegistrationProvisioningDetails) {
  const context: Record<string, unknown> = {
    stage: details.stage,
    outcome: details.outcome,
  }
  const tags: Record<string, string> = {
    "free_registration.stage": details.stage,
    "free_registration.provisioning_outcome": details.outcome,
  }
  if (details.reasonCode) {
    context.reason_code = details.reasonCode
    tags["free_registration.reason_code"] = details.reasonCode
  }
  if (details.userId) context.user_id = details.userId
  return { tags, context }
}

/**
 * Reports one non-success provisioning outcome. Never throws — a telemetry
 * failure must not turn a served page into an error.
 */
export function reportFreeProvisioningOutcome(
  result: ProvisionFreeInitialSnapshotResult,
  input: { stage: FreeRegistrationProvisioningStage; userId?: string | null },
  sink: Sink = Sentry,
): void {
  if (!isFreeProvisioningFailure(result)) return
  const reasonCode = result.outcome === "invalid_source" ? (result.reasonCode ?? null) : null
  const details: FreeRegistrationProvisioningDetails = {
    stage: input.stage,
    outcome: result.outcome,
    reasonCode,
    ...(input.userId ? { userId: input.userId } : {}),
  }

  console.error("[free-registration] snapshot provisioning did not complete", {
    stage: details.stage,
    outcome: details.outcome,
    ...(reasonCode ? { reasonCode } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
  })

  try {
    const payload = buildFreeProvisioningPayload(details)
    sink.withScope((scope) => {
      for (const [key, value] of Object.entries(payload.tags)) scope.setTag(key, value)
      scope.setContext("free_registration", payload.context)
      scope.setLevel?.(resolveFreeProvisioningLevel(details.outcome))
      sink.captureException(
        new Error(`free snapshot provisioning ${details.outcome} (${details.stage})`),
      )
    })
  } catch {
    /* Telemetry is never allowed to break the page it observes. */
  }
}
