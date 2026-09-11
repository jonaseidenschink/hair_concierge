"use client"

import { useCallback, useEffect, useState } from "react"
import { Bookmark, ExternalLink, X } from "lucide-react"

import { BottomSheet, BottomSheetContent, BottomSheetTitle } from "@/components/ui/bottom-sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { ScanWishlistEntry } from "@/app/api/scan/wishlist/route"
import { scanAlternativeMetaLine } from "@/lib/scan/result-presentation"
import { useLatestRequest } from "@/lib/scan/use-latest-request"

import { ScanLockBadge } from "./scan-lock-badge"
import { ScanProductThumb } from "./scan-product-thumb"

/**
 * Merkliste surface (UI spec §5): the whole list lives in this sheet — no page, no nav
 * entry in v1. Entry point is the bookmark button in the scan screen header.
 */

const EMPTY_COPY = "Noch nichts gemerkt. Scanne ein Produkt und speichere es hier."
const ERROR_COPY = "Deine Merkliste lässt sich gerade nicht laden."

/**
 * `locked` is the free tier's Merken gate (T9): `/api/scan/wishlist` denies a free user
 * server-side, so the bookmark opens the Premium sheet instead of a list it may not read.
 * The marker is a CORNER badge — the bookmark symbol itself stays fully visible (binding
 * constraint, same contract as T3's `NavLockBadge`).
 *
 * PR2 review fix (C4): `locked` and `!locked` are two fully separate branches, not one
 * markup shape with conditional attributes/classes layered on top — the unlocked branch is
 * byte-identical to this component's pre-T9 markup (no `data-scan-wishlist-locked`
 * attribute at all, no `relative` in the class list), matching the same pattern
 * `ScanActionFooter`'s `saveLocked` branch already uses. A free/premium mid-render is never
 * observable to markup as "true"/"false" on the same shape — only as present-or-absent.
 */
export function ScanWishlistTrigger({
  onClick,
  locked = false,
}: {
  onClick: () => void
  locked?: boolean
}) {
  return locked ? (
    <button
      type="button"
      onClick={onClick}
      data-scan-wishlist-locked="true"
      aria-label="Merkliste öffnen — Premium"
      className="relative flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
    >
      <Bookmark className="h-5 w-5" aria-hidden="true" />
      {/* The 44px tap target is much larger than the 20px symbol inside it: without this
          offset the badge would float in empty space at the button's corner instead of
          marking the bookmark it belongs to. */}
      <ScanLockBadge className="right-[7px] top-[7px]" />
    </button>
  ) : (
    <button
      type="button"
      onClick={onClick}
      aria-label="Merkliste öffnen"
      className="flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
    >
      <Bookmark className="h-5 w-5" aria-hidden="true" />
    </button>
  )
}

export function ScanWishlistSheet({
  open,
  onOpenChange,
  onOpenProduct,
  onBuy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tapping an entry resolves it as a scan result again. */
  onOpenProduct: (productId: string) => void
  /** A "Kaufen ↗" in this list is a buy click too; the list carries no verdict. */
  onBuy: (productId: string) => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [entries, setEntries] = useState<ScanWishlistEntry[]>([])
  const requests = useLatestRequest()

  const load = useCallback(async () => {
    // Close/reopen and the "Erneut versuchen" button can both leave an older GET in
    // flight; without the guard its late response overwrites the newer list — or paints
    // an error over a list that loaded fine (F13).
    const token = requests.begin()
    setStatus("loading")
    try {
      const response = await fetch("/api/scan/wishlist", { cache: "no-store" })
      if (!response.ok) throw new Error("wishlist_unavailable")
      const body = (await response.json()) as { entries: ScanWishlistEntry[] }
      if (!requests.isCurrent(token)) return
      setEntries(body.entries ?? [])
      setStatus("ready")
    } catch {
      if (!requests.isCurrent(token)) return
      setStatus("error")
    }
  }, [requests])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function remove(productId: string) {
    const index = entries.findIndex((entry) => entry.productId === productId)
    if (index < 0) return
    const removed = entries[index]
    const precededBy = entries.slice(0, index).map((entry) => entry.productId)
    setEntries((current) => current.filter((entry) => entry.productId !== productId))
    try {
      const response = await fetch("/api/scan/save", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, kind: "merkliste" }),
      })
      if (!response.ok) throw new Error("remove_failed")
    } catch {
      // Re-insert THIS entry only. Restoring the whole array as it looked before the
      // request would also resurrect every other removal that happened meanwhile, and
      // would undo a reload that landed in between (F13). The row goes back behind the
      // last of its former predecessors that is still listed, so a plain failure puts it
      // exactly where it was and a concurrent removal cannot shuffle it to the end.
      setEntries((current) => {
        if (current.some((entry) => entry.productId === productId)) return current
        let at = 0
        current.forEach((entry, position) => {
          if (precededBy.includes(entry.productId)) at = position + 1
        })
        return [...current.slice(0, at), removed, ...current.slice(at)]
      })
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent
        className="max-h-[80vh]"
        contentClassName="px-4 pb-6 sm:px-5"
        header={
          <div className="px-4 pb-2 pt-1 sm:px-5">
            <BottomSheetTitle className="text-[17px]">Merkliste</BottomSheetTitle>
          </div>
        }
      >
        {status === "loading" ? (
          <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-[68px] w-full rounded-[12px]" />
            ))}
          </div>
        ) : null}

        {status === "error" ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">{ERROR_COPY}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 min-h-[44px] text-sm font-semibold text-[var(--brand-plum)] underline-offset-4 hover:underline"
            >
              Erneut versuchen
            </button>
          </div>
        ) : null}

        {status === "ready" && entries.length === 0 ? (
          <p className="py-8 text-center text-sm leading-6 text-muted-foreground">{EMPTY_COPY}</p>
        ) : null}

        {status === "ready" && entries.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const meta = scanAlternativeMetaLine({
                brand: entry.brand,
                priceLabel: entry.priceLabel,
              })
              return (
                <li
                  key={entry.productId}
                  className="flex items-center gap-3 rounded-[12px] border border-border bg-card px-3 py-2.5"
                >
                  <button
                    type="button"
                    onClick={() => onOpenProduct(entry.productId)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
                  >
                    <ScanProductThumb imageUrl={entry.imageUrl} label={entry.name} size={44} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-foreground">
                        {entry.name}
                      </span>
                      {meta ? (
                        <span className="mt-0.5 block text-[12px] text-muted-foreground">
                          {meta}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {entry.purchaseUrl ? (
                    <a
                      href={entry.purchaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => onBuy(entry.productId)}
                      className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[var(--brand-coral-dark)] underline-offset-4 hover:underline"
                    >
                      Kaufen
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void remove(entry.productId)}
                    aria-label={`${entry.name} von der Merkliste entfernen`}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)]"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </BottomSheetContent>
    </BottomSheet>
  )
}
