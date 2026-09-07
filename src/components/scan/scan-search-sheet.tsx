"use client"

import { useEffect, useId, useState } from "react"

import { BottomSheet, BottomSheetContent, BottomSheetTitle } from "@/components/ui/bottom-sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { ScanSearchResult } from "@/app/api/scan/search/route"

import { useLatestRequest } from "@/lib/scan/use-latest-request"

import { ManualEanField } from "./manual-ean-field"
import { ScanProductThumb } from "./scan-product-thumb"

/**
 * Fallback sheet (UI spec §7). Opens from the "Produkt suchen" link, after the scanner
 * fails to get a stable read, or when the camera is unavailable — the scanner is an
 * enhancement, this is the path that always works.
 *
 * The header answers the question the user actually has, which depends on how they got
 * here (plan 2026-09-05): after the 3s timeout the sheet appeared on its own while they
 * were still pointing at a barcode, so it names that ("Barcode nicht lesbar?") and says
 * what happens next. Opened deliberately, or after a camera failure they have already
 * been told about, it stays the plain "Ohne Scan finden".
 */

export type ScanSearchReason = "timeout" | "manual" | "camera"

const TIMEOUT_TITLE = "Barcode nicht lesbar?"
const TIMEOUT_SUBLINE = "So findest du's trotzdem."
const DEFAULT_TITLE = "Ohne Scan finden"

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 250
const EMPTY_COPY =
  "Nichts gefunden — prüfe die Schreibweise oder reiche das Produkt per Barcode ein."
const ERROR_COPY = "Die Suche klappt gerade nicht."

type SearchStatus = "idle" | "loading" | "ready" | "error"

export function ScanSearchSheet({
  open,
  reason,
  onOpenChange,
  onSelectProduct,
  onSubmitIdentifier,
}: {
  open: boolean
  /** Why this sheet is up. Drives the header only — the search itself is identical. */
  reason: ScanSearchReason
  onOpenChange: (open: boolean) => void
  onSelectProduct: (productId: string) => void
  onSubmitIdentifier: (identifier: { type: "ean"; value: string }) => void
}) {
  const fieldId = useId()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<SearchStatus>("idle")
  const [results, setResults] = useState<ScanSearchResult[]>([])
  const requests = useLatestRequest()

  useEffect(() => {
    if (!open) {
      // Invalidate anything still in flight: without it, a response that lands after
      // the sheet closed still writes results/status into a fresh session and the next
      // open flashes the previous query's hits.
      requests.invalidateAll()
      setQuery("")
      setResults([])
      setStatus("idle")
    }
  }, [open, requests])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Deleting back below the minimum cancels the pending request too — otherwise its
      // late response would repaint results for a query the user already erased.
      requests.invalidateAll()
      setStatus("idle")
      setResults([])
      return
    }
    const token = requests.begin()
    setStatus("loading")
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/scan/search?q=${encodeURIComponent(trimmed)}`, {
          cache: "no-store",
        })
        if (!response.ok) throw new Error("search_unavailable")
        const body = (await response.json()) as { results: ScanSearchResult[] }
        if (!requests.isCurrent(token)) return
        setResults(body.results ?? [])
        setStatus("ready")
      } catch {
        if (!requests.isCurrent(token)) return
        setStatus("error")
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [query, requests])

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent
        className="max-h-[85vh]"
        contentClassName="px-4 pb-6 sm:px-5"
        header={
          <div className="px-4 pb-2 pt-1 sm:px-5">
            <BottomSheetTitle className="text-[17px]">
              {reason === "timeout" ? TIMEOUT_TITLE : DEFAULT_TITLE}
            </BottomSheetTitle>
            {reason === "timeout" ? (
              <p className="mt-0.5 text-sm leading-6 text-[var(--text-sub)]">{TIMEOUT_SUBLINE}</p>
            ) : null}
          </div>
        }
      >
        <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium">
          Produktname
        </label>
        <input
          id={fieldId}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="z. B. Olaplex No. 4"
          className="w-full rounded-[10px] border border-border bg-card px-4 py-3.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
        />

        <div className="mt-3 min-h-[64px]" aria-live="polite">
          {status === "loading" ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-[64px] w-full rounded-[12px]" />
              ))}
            </div>
          ) : null}

          {status === "error" ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{ERROR_COPY}</p>
          ) : null}

          {status === "ready" && results.length === 0 ? (
            <p className="py-4 text-center text-sm leading-6 text-muted-foreground">{EMPTY_COPY}</p>
          ) : null}

          {status === "ready" && results.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {results.map((result) => (
                <li key={result.id}>
                  <button
                    type="button"
                    onClick={() => onSelectProduct(result.id)}
                    className="flex w-full items-center gap-3 rounded-[12px] border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-[var(--brand-plum)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] focus-visible:ring-offset-2"
                  >
                    <ScanProductThumb imageUrl={result.imageUrl} label={result.name} size={44} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-foreground">
                        {result.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                        {result.brand ? `${result.brand} · ` : ""}
                        {result.categoryLabel}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">oder</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <ManualEanField onSubmit={onSubmitIdentifier} />
      </BottomSheetContent>
    </BottomSheet>
  )
}
