import { claimCheckoutFailure, type CheckoutFailureStage } from "./events"

export type CheckoutAttemptOpenResult = {
  checkoutAttemptId: string
  isNew: boolean
}

export function createCheckoutAttemptController(
  createId: () => string = () => crypto.randomUUID(),
) {
  let activeCheckoutAttemptId: string | null = null
  const seenFailureBranches = new Set<string>()

  return {
    open(): CheckoutAttemptOpenResult {
      if (activeCheckoutAttemptId) {
        return { checkoutAttemptId: activeCheckoutAttemptId, isNew: false }
      }

      activeCheckoutAttemptId = createId()
      return { checkoutAttemptId: activeCheckoutAttemptId, isNew: true }
    },

    retry() {
      return activeCheckoutAttemptId
    },

    close() {
      const closedCheckoutAttemptId = activeCheckoutAttemptId
      activeCheckoutAttemptId = null
      return closedCheckoutAttemptId
    },

    claimFailure(
      checkoutAttemptId: string,
      provider: "stripe" | "paypal",
      failureStage: CheckoutFailureStage,
      errorCode: string,
    ) {
      return claimCheckoutFailure(
        seenFailureBranches,
        checkoutAttemptId,
        provider,
        failureStage,
        errorCode,
      )
    },
  }
}

export type CheckoutAttemptController = ReturnType<typeof createCheckoutAttemptController>
