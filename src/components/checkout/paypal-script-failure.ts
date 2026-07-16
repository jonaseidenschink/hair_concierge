export type PayPalScriptLoadFailure = {
  errorCode: "paypal_js_load_failed"
  failureStage: "provider_session"
  retryable: true
}

export function reportPayPalScriptFailureOnce(
  reported: { current: boolean },
  isRejected: boolean,
  onFailure?: (failure: PayPalScriptLoadFailure) => void,
) {
  if (!isRejected || reported.current) return false

  reported.current = true
  onFailure?.({
    errorCode: "paypal_js_load_failed",
    failureStage: "provider_session",
    retryable: true,
  })
  return true
}
