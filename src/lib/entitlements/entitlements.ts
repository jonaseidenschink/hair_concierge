export type EntitlementTier = "free" | "premium"

export interface Entitlements {
  tier: EntitlementTier
  canSeeAlternatives: boolean
  canSave: boolean
  canChat: boolean
  canEditHairCheck: boolean
  freeRevealAvailable: boolean
}

export interface EntitlementInputs {
  /** Current paid app access, same semantics as the existing hasCurrentAppAccess check. */
  hasAppAccess: boolean
  /** Whether the one-lifetime free reveal has been consumed. Reader lands in a later task; injected here. */
  freeRevealUsed: boolean
}

/** Pure derivation of entitlements from resolved inputs. No side effects. */
export function deriveEntitlements(inputs: EntitlementInputs): Entitlements {
  if (inputs.hasAppAccess) {
    return {
      tier: "premium",
      canSeeAlternatives: true,
      canSave: true,
      canChat: true,
      canEditHairCheck: true,
      freeRevealAvailable: false,
    }
  }

  return {
    tier: "free",
    canSeeAlternatives: false,
    canSave: false,
    canChat: false,
    canEditHairCheck: false,
    freeRevealAvailable: !inputs.freeRevealUsed,
  }
}

/** Thin async loader: resolves inputs via injected deps, then calls deriveEntitlements. */
export async function getEntitlements(
  userId: string,
  deps: {
    hasAppAccess: (userId: string) => Promise<boolean>
    readFreeRevealUsed?: (userId: string) => Promise<boolean>
  },
): Promise<Entitlements> {
  const readFreeRevealUsed = deps.readFreeRevealUsed ?? (async () => false)

  const hasAppAccess = await deps.hasAppAccess(userId)
  if (hasAppAccess) {
    return deriveEntitlements({ hasAppAccess: true, freeRevealUsed: false })
  }

  const freeRevealUsed = await readFreeRevealUsed(userId)
  return deriveEntitlements({ hasAppAccess: false, freeRevealUsed })
}
