export function getAuthenticatedCheckoutSuccessRedirect(
  onboardingCompleted: boolean | null | undefined,
  reactivationReturnDestination?: string | null,
) {
  if (!onboardingCompleted) return "/onboarding"
  return reactivationReturnDestination ?? "/profile?membership=reactivated"
}
