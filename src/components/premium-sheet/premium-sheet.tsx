"use client"

import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { PREMIUM_FEATURES, type PremiumSheetContext } from "@/lib/premium-sheet/context"
import { orderedBenefits } from "@/lib/premium-sheet/ordered-benefits"
import { cn } from "@/lib/utils"

/**
 * Stub Premium sheet (T5, freemium-scanner-first PR1). Renders the opener contract —
 * kicker, headline, three ordered benefits, a placeholder CTA — with no payment or
 * pricing behind it, so every gate landing in PR2/PR3/PR5 can integrate against a stable
 * interface. PR4 swaps the body for the real paywall while keeping this contract.
 *
 * Reuses `BottomSheet`/`BottomSheetContent` (the same primitive as the scan feature's
 * sheets, e.g. `ScanSaveSheet`) rather than inventing a second sheet shell.
 */
export function PremiumSheet({
  open,
  context,
  onClose,
}: {
  open: boolean
  context: PremiumSheetContext | null
  onClose: () => void
}) {
  const benefits = orderedBenefits(context)

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <BottomSheetContent
        contentClassName="px-5 pb-6"
        header={
          <div className="px-5 pb-1 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-plum-dark)]">
              Chaarlie Premium
            </p>
            <BottomSheetTitle className="mt-1 text-[19px]">Alles für dein Haar.</BottomSheetTitle>
          </div>
        }
        footer={
          <Button variant="cta" className="w-full" onClick={onClose}>
            Weiter
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {benefits.map((featureId, index) => {
            const feature = PREMIUM_FEATURES[featureId]
            const accented = index === 0
            return (
              <li
                key={featureId}
                className={cn(
                  "rounded-[12px] border px-3 py-3",
                  accented
                    ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)]"
                    : "border-border bg-card",
                )}
              >
                <p className="text-sm font-bold text-foreground">{feature.name}</p>
                <BottomSheetDescription className="mt-1">{feature.benefit}</BottomSheetDescription>
              </li>
            )
          })}
        </ul>
      </BottomSheetContent>
    </BottomSheet>
  )
}
