"use client"

import { useCallback, useEffect, useState } from "react"

import { ScanProductThumb } from "@/components/scan/scan-product-thumb"
import { ScanSaveSheet, type ScanSaveCompletion } from "@/components/scan/scan-save-sheet"
import { Button } from "@/components/ui/button"
import { useToast } from "@/providers/toast-provider"
import { scanAlternativeMetaLine } from "@/lib/scan/result-presentation"
import type { ScanSavedStatePayload } from "@/lib/scan/saved-state"
import type { ScanWishlistEntry } from "@/app/api/scan/wishlist/route"

/**
 * T16, fix round 1 (F1): the „Gemerkt" section is shared between the legacy Routine page
 * (`RoutinePageClient`) and the personal-plan Routine page (`PersonalPlanRoutineClient` /
 * `RoutinePage`) — the original implementation only lived on the legacy branch, which left
 * the scanner bookmark's `/routine#gemerkt` deep-link dead for every freemium-provisioned
 * or current-subscriber premium user (they resolve to the personal-plan branch). Extracted
 * here so both callers render byte-identical markup, state and handlers instead of two
 * copies drifting apart.
 */

const GEMERKT_EMPTY_COPY = "Noch nichts gemerkt. Scanne ein Produkt und speichere es hier."
const GEMERKT_REMOVE_FAILED_TOAST = "Entfernen fehlgeschlagen. Bitte versuche es noch einmal."

/**
 * Fix round 1 (F7): every entry rendered here came straight from `GET /api/scan/wishlist`
 * — i.e. it IS a `scan_wishlist` row right now — so `state: "merkliste"` /
 * `managedByScan: true` is not a guess about server state, it is what the listing itself
 * already asserts (see the doc comment on `removeScanWishlistProduct` in
 * `src/lib/scan/saved-state.ts`: "Every scan_wishlist row belongs to the scan surface, so
 * this can never be refused"). Named and documented here instead of an inline literal at
 * the `ScanSaveSheet` call site, so the one place this assumption lives is easy to find.
 * The residual risk (a row removed by another tab between the list fetch and this tap)
 * degrades to a harmless idempotent no-op, not a wrong write: reopening "merkliste" on an
 * already-gone row is a DELETE that matches nothing.
 */
const WISHLIST_ENTRY_SAVED_STATE: ScanSavedStatePayload = {
  state: "merkliste",
  managedByScan: true,
}

export function GemerktSection({
  merklisteEnabled,
  onGraduated,
  readOnly = false,
}: {
  /**
   * Server-derived freemium-flag gate (see `RoutinePage`'s doc comment in
   * `app/routine/page.tsx`) — never a client flag read. Defaults to `false` so a caller
   * that forgets to pass it stays on today's exact behavior: no section, no
   * `/api/scan/wishlist` fetch at all.
   */
  merklisteEnabled?: boolean
  /**
   * Fix round 1 (F6): called after a product graduates INTO the routine (the user picked
   * "Benutze ich schon" in the hand-off sheet), so the caller can refresh whatever list
   * renders the confirmed routine — this section only owns its own „Gemerkt" list, not the
   * routine list it hands products off to.
   *
   * PR5 review fix (Z3): it now carries WHICH product graduated. Before this, the product
   * simply vanished from „Gemerkt" and nothing else on the page changed — the caller had
   * no way to name it, so it could neither show where the product went nor hand the user
   * into the routine-editor flow for it.
   */
  onGraduated?: (product: { productId: string; name: string }) => void
  /**
   * T17 keepsake: a LAPSED owner keeps READING their Merkliste (the listing is what
   * „nothing free is ever removed" means here), but both write affordances —
   * „Zur Routine hinzufügen" (which opens the save/move sheet) and the × remove — are
   * premium mutations whose endpoints answer 403 for them. Omitted rather than shown
   * failing: an affordance that cannot work is worse than no affordance, and the page's
   * own „Anpassen" lock already carries the gate for this surface. Defaults to `false`,
   * so premium and flag-off render byte-identically to today.
   */
  readOnly?: boolean
} = {}) {
  const { toast } = useToast()
  const [wishlistVisible, setWishlistVisible] = useState(false)
  const [wishlist, setWishlist] = useState<ScanWishlistEntry[]>([])
  const [graduateEntry, setGraduateEntry] = useState<ScanWishlistEntry | null>(null)

  // `wishlistVisible` stays `false` for flag-off AND for a free-tier user whose
  // `/api/scan/wishlist` read 403s (or any other read failure) — this section is cosmetic
  // and failure-tolerant like `portfolioPresentation`/`refinementBanner` elsewhere on the
  // Routine page: a load that cannot be trusted simply means no section, never a broken
  // Routine or new behavior surfaced to a free user.
  useEffect(() => {
    if (!merklisteEnabled) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/scan/wishlist", { cache: "no-store" })
        if (!response.ok) return
        const body = (await response.json()) as { entries?: ScanWishlistEntry[] }
        if (cancelled) return
        setWishlist(Array.isArray(body.entries) ? body.entries : [])
        setWishlistVisible(true)
      } catch {
        // Fail silent — see the comment above.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [merklisteEnabled])

  // Deep-link from the scanner bookmark (`/routine#gemerkt`, T16): scroll once the section
  // has real content to scroll to — the element does not exist yet during the initial
  // loading render, so the browser's own hash-scroll-on-load cannot find it.
  useEffect(() => {
    if (!wishlistVisible) return
    if (typeof window === "undefined" || window.location.hash !== "#gemerkt") return
    document.getElementById("gemerkt")?.scrollIntoView({ block: "start" })
  }, [wishlistVisible])

  const removeFromWishlist = useCallback(
    async (entry: ScanWishlistEntry) => {
      const previous = wishlist
      setWishlist((current) => current.filter((row) => row.productId !== entry.productId))
      try {
        const response = await fetch("/api/scan/save", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: entry.productId, kind: "merkliste" }),
        })
        if (!response.ok) throw new Error("remove_failed")
      } catch {
        setWishlist(previous)
        toast({ title: GEMERKT_REMOVE_FAILED_TOAST, variant: "destructive" })
      }
    },
    [wishlist, toast],
  )

  /**
   * Graduation hand-off: this section never writes to the routine itself — it only opens
   * the EXISTING „Wohin speichern?" sheet (`ScanSaveSheet`, unchanged — the same save/move
   * endpoint the scan flow's own Merken tap already uses) for the tapped product. The
   * actual write, if any, happens only once the user explicitly picks a destination inside
   * that sheet; this component just reflects the sheet's own report afterwards by dropping
   * the product from THIS list (it left "merkliste" either way — moved to the routine, or
   * removed outright) and, on an actual routine graduation (fix round 1, F6), telling the
   * caller to refresh its own routine list.
   */
  const handleGraduated = useCallback(
    (completion: ScanSaveCompletion) => {
      const graduated = wishlist.find((row) => row.productId === completion.productId)
      setWishlist((current) => current.filter((row) => row.productId !== completion.productId))
      setGraduateEntry(null)
      // Z3: the caller is told WHICH product graduated, so it can show the user where it
      // went instead of leaving them with a product that silently disappeared from here.
      if (completion.savedState.state === "routine") {
        onGraduated?.({
          productId: completion.productId,
          name: graduated?.name ?? "Das Produkt",
        })
      }
    },
    [onGraduated, wishlist],
  )

  if (!wishlistVisible) return null

  return (
    <>
      <section
        id="gemerkt"
        aria-labelledby="gemerkt-heading"
        className="scroll-mt-4 border-t border-border pt-4"
      >
        <h2
          id="gemerkt-heading"
          className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Gemerkt
        </h2>
        {wishlist.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{GEMERKT_EMPTY_COPY}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {wishlist.map((entry) => {
              const meta = scanAlternativeMetaLine({
                brand: entry.brand,
                priceLabel: entry.priceLabel,
              })
              return (
                <li
                  key={entry.productId}
                  className="flex items-center gap-3 rounded-[12px] border border-border bg-card px-3 py-2.5"
                >
                  <ScanProductThumb imageUrl={entry.imageUrl} label={entry.name} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-foreground">
                      {entry.name}
                    </span>
                    {meta ? (
                      <span className="mt-0.5 block text-[12px] text-muted-foreground">{meta}</span>
                    ) : null}
                  </span>
                  {readOnly ? null : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-auto shrink-0"
                        onClick={() => setGraduateEntry(entry)}
                      >
                        Zur Routine hinzufügen
                      </Button>
                      <button
                        type="button"
                        onClick={() => void removeFromWishlist(entry)}
                        aria-label={`${entry.name} von der Merkliste entfernen`}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)]"
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {graduateEntry ? (
        <ScanSaveSheet
          open={graduateEntry !== null}
          productId={graduateEntry.productId}
          savedState={WISHLIST_ENTRY_SAVED_STATE}
          onOpenChange={(open) => {
            if (!open) setGraduateEntry(null)
          }}
          onSavedStateChange={handleGraduated}
        />
      ) : null}
    </>
  )
}
