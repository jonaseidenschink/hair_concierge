/**
 * Feature flag for the freemium "scanner-first" restructure (see
 * plans/freemium-scanner-first/plan.md). Read directly from process.env on
 * every call so callers on the Edge runtime (middleware) stay Edge-safe:
 * no Node-only APIs, no cached/derived module state.
 */
export function isFreemiumScannerFirstEnabled(): boolean {
  return process.env.FREEMIUM_SCANNER_FIRST_ENABLED === "true"
}
