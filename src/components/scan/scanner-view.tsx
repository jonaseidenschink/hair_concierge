"use client"

import type { RefObject } from "react"

import { SCAN_CONFIRM_LABEL, SCAN_HINT_SPOTTED, type ScanHint } from "@/lib/scan/guidance"
import type { ScanVisualState } from "@/lib/scan/scanner-session"
import { cn } from "@/lib/utils"

const CORNER_POSITIONS = [
  "left-0 top-0 rounded-tl-lg border-l-2 border-t-2",
  "right-0 top-0 rounded-tr-lg border-r-2 border-t-2",
  "bottom-0 left-0 rounded-bl-lg border-b-2 border-l-2",
  "bottom-0 right-0 rounded-br-lg border-b-2 border-r-2",
] as const

/** The outline's position inside the viewfinder, in the viewfinder's own CSS pixels. */
export type ScannerOutlineRect = { left: number; top: number; width: number; height: number }

export type ScannerViewProps = {
  /** What to draw. Derived by `Scanner` (see `deriveViewfinderPresentation`). */
  visual: ScanVisualState
  /** Where to draw the outline, already mapped to CSS pixels; `null` draws none. */
  outlineBox: ScannerOutlineRect | null
  /** The pill's text while `visual` is `searching` — idle or situational. */
  hint: ScanHint
  /** The 400ms decode-confirm window is running. */
  confirmActive: boolean
  /** A sheet covers the viewfinder and the detection loop is paused. */
  detectionPaused: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  frameRef: RefObject<HTMLDivElement | null>
  /**
   * Text for the polite live region — debounced and rate-limited by `Scanner`, because
   * the visual pill may flip far faster than a screen reader can usefully follow.
   */
  announcement: string
}

/**
 * The viewfinder's pixels and nothing else: no hooks, no camera, no detection. Every
 * input is a prop, so the three visual states are testable without mounting a camera.
 *
 * - `searching`: corners breathe, the pill shows the idle hint (or a situational one)
 *   behind a small pulsing dot.
 * - `spotted`: an amber outline sits on the barcode the loop can see but has not read
 *   yet, and the pill asks the user to hold still.
 * - `read`: the outline and corners turn green for the confirm window and the pill goes
 *   plum — the moment the flow uses to slide the result sheet up.
 *
 * Every animation is declared only inside `prefers-reduced-motion: no-preference`
 * (globals.css), and all of them stop while `detectionPaused` — a frozen camera behind a
 * sheet must not look like it is still working.
 */
export function ScannerView({
  visual,
  outlineBox,
  hint,
  confirmActive,
  detectionPaused,
  videoRef,
  frameRef,
  announcement,
}: ScannerViewProps) {
  // The confirm window is exempt: that green/plum flash belongs to the decode the user
  // just made, and the result sheet is rising over it by design.
  const frozen = detectionPaused && !confirmActive
  const breathing = visual === "searching" && !frozen

  return (
    <div
      ref={frameRef}
      data-scan-detection={visual}
      className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-black"
    >
      <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />

      {/* The barcode the loop can see: amber while it is only spotted, green once read */}
      {outlineBox ? (
        <div
          aria-hidden
          data-scan-outline={visual}
          style={{
            left: `${outlineBox.left}px`,
            top: `${outlineBox.top}px`,
            width: `${outlineBox.width}px`,
            height: `${outlineBox.height}px`,
          }}
          className={cn(
            "pointer-events-none absolute rounded-md motion-safe:transition-[left,top,width,height] motion-safe:duration-150",
            visual === "read"
              ? "border-[2.5px] border-[var(--status-ok-text)] shadow-[0_0_0_4px_rgba(53,107,69,.28)]"
              : "border-[2.5px] border-[#e0a13a] shadow-[0_0_0_4px_rgba(224,161,58,.28)]",
          )}
        />
      ) : null}

      {/* Viewfinder corner markers — breathing while searching, green once read */}
      <div className="pointer-events-none absolute inset-6 sm:inset-10" aria-hidden>
        {CORNER_POSITIONS.map((corner) => (
          <span
            key={corner}
            className={cn(
              "absolute h-8 w-8 transition-colors",
              corner,
              visual === "read" ? "border-[var(--status-ok-text)]" : "border-white/90",
              breathing && "animate-scan-breathe",
            )}
          />
        ))}
      </div>

      {/* Hint pill / spotted pill / decode-confirm pill */}
      <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-6">
        <span
          data-scan-pill=""
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white backdrop-blur-sm",
            visual === "read" && "bg-[var(--brand-plum)] font-semibold",
            visual === "spotted" && "bg-[#b97a17] font-semibold",
            visual === "searching" && "bg-black/70",
          )}
        >
          {visual === "searching" && !frozen ? (
            <span
              aria-hidden
              data-scan-pill-dot=""
              className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--brand-plum-light)] animate-scan-dot"
            />
          ) : null}
          {visual === "read" ? `✓ ${SCAN_CONFIRM_LABEL}` : null}
          {visual === "spotted" ? SCAN_HINT_SPOTTED : null}
          {visual === "searching" ? hint : null}
        </span>
      </div>

      {/*
        The accessible copy of the pill. Separate from the visual pill on purpose: the
        pill flips as fast as the detector does, and an `aria-live` region on it would
        read every flicker out loud.
      */}
      <span data-scan-announcement="" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}
