import { Button } from "@/components/ui/button"
import { ProfileLockBadge } from "@/components/profile/profile-lock-badge"
import type { EntitlementTier } from "@/lib/entitlements"

/**
 * The Haar-Check header edit affordance (T15 fix round 1, F1/F3).
 * Extracted from `src/app/profile/page.tsx` so the free/premium gate has
 * real render coverage instead of only source-text regex assertions (F3).
 *
 * F1 fix: the corner lock renders as a SIBLING of the shadcn `Button`, not a
 * child. `Button`'s base class list sets `[&_svg]:size-4`
 * (`components/ui/button.tsx`), which beats `ProfileLockBadge`'s `h-2 w-2`
 * Lock glyph on CSS specificity and blows it up to 16px inside the 13px
 * badge circle, spilling onto the corner and label. Wrapping both in a
 * `relative inline-flex` span keeps the badge positioned at the Button's
 * corner without the icon selector ever reaching it — the same escape
 * scan's plain-`<button>` usages use (`scan-action-footer.tsx`,
 * `scan-wishlist-sheet.tsx`), adapted here for the shadcn Button.
 *
 * Stays presentational: `onEdit` always fires, tier-branching (open the
 * Premium sheet vs. actually enter edit mode) stays inside the page's single
 * choke point, `startQuizEditing`, so the corner lock here is purely visual
 * and the gate logic is not duplicated.
 *
 * F2 fix: the premium/flag-off branch renders the bare `Button`, byte-for-byte
 * what this page rendered before T15 — no `relative` class, no wrapper span.
 * Only the free branch gets the wrapper, since only it needs one.
 */
export function HaarCheckEditControl({
  tier,
  onEdit,
}: {
  tier: EntitlementTier
  onEdit: () => void
}) {
  if (tier === "free") {
    return (
      <span className="relative inline-flex">
        <Button
          type="button"
          variant="outline"
          className="w-auto"
          aria-label="Haar-Check bearbeiten — Premium"
          onClick={onEdit}
        >
          Haar-Check bearbeiten
        </Button>
        <ProfileLockBadge />
      </span>
    )
  }

  return (
    <Button type="button" variant="outline" className="w-auto" onClick={onEdit}>
      Haar-Check bearbeiten
    </Button>
  )
}
