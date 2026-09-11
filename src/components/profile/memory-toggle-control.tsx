import { Switch } from "@/components/ui/switch"
import { ProfileLockBadge } from "@/components/profile/profile-lock-badge"
import type { EntitlementTier } from "@/lib/entitlements"

/**
 * The Erinnerungen (memory) toggle in the Profil "Einstellungen" section
 * (T15 fix round 1, F5 — controller ruling).
 *
 * `/api/memory` is subscription-gated and not freemium-admitted (see
 * `plans/freemium-scanner-first/enforcement-matrix.md`), so a free user's
 * `GET /api/memory` 403s into a silent `catch`, `memoryEnabled` keeps its
 * default `true`, and toggling PATCHes into another 403 — a broken,
 * un-gated premium control shown to a free user instead of the Premium
 * sheet. This corner-locks the toggle itself (F1's sibling-badge pattern:
 * the badge is a sibling of the `Switch`, never a child) and, for a free
 * user, routes every tap straight to the Premium sheet instead of ever
 * calling `/api/memory`.
 *
 * The locked `Switch` is intentionally not `disabled` — same convention as
 * `HaarCheckEditControl`'s free-tier Button — so it stays reachable by
 * keyboard/screen reader and tapping it opens the sheet rather than doing
 * nothing.
 */
export function MemoryToggleControl({
  tier,
  checked,
  disabled,
  onCheckedChange,
  onLockedTap,
}: {
  tier: EntitlementTier
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  onLockedTap: () => void
}) {
  if (tier === "free") {
    return (
      <span className="relative inline-flex">
        <Switch
          checked={false}
          aria-label="Erinnerungen aktivieren — Premium"
          onCheckedChange={onLockedTap}
        />
        <ProfileLockBadge />
      </span>
    )
  }

  return (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label="Erinnerungen aktivieren"
    />
  )
}
