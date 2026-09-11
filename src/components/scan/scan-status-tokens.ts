import type { ScanStatusToken } from "@/lib/scan/types"

/**
 * The `--status-*` design tokens the scan surfaces paint verdict state with. Extracted
 * from `scan-result-card.tsx` so the free-tier masked comparison (T9) can reuse the exact
 * same palette without importing the card it is rendered by.
 */

export const SCAN_STATUS_CLASS: Record<ScanStatusToken, string> = {
  ok: "bg-[var(--status-ok-bg)] text-[var(--status-ok-text)]",
  pending: "bg-[var(--status-pending-bg)] text-[var(--status-pending-text)]",
  danger: "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]",
  neutral: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-text)]",
}

export const SCAN_MARKER_CLASS: Record<ScanStatusToken, string> = {
  ok: "text-[var(--status-ok-text)]",
  pending: "text-[var(--status-pending-text)]",
  danger: "text-[var(--status-danger-text)]",
  neutral: "text-muted-foreground",
}
