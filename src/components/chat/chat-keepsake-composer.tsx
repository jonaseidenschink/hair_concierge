"use client"

import { Send } from "lucide-react"

import { KeepsakeLockBadge } from "@/components/keepsake/keepsake-lock-badge"

/**
 * The locked composer a LAPSED owner sees under their own, still-readable chat history
 * (T17, freemium-scanner-first PR5).
 *
 * It occupies the exact slot `ChatInput` occupies and keeps its shape, so the page reads
 * as "your chat, paused" rather than "your chat, gone". The whole row is one control:
 * tapping anywhere in it opens the Premium sheet, which is the only thing it can do —
 * there is no text field to type into and nothing to submit, so no request can leave this
 * component at all (`POST /api/chat` stays middleware-denied for this user regardless).
 *
 * One accessible name for the whole gate ("Chat freischalten — Premium"); the lock badge
 * is decorative, matching the `NavLockBadge`/`ScanLockBadge`/`ProfileLockBadge` contract.
 */
export function ChatKeepsakeComposer({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-2px_12px_rgba(0,0,0,0.04)]">
      <button
        type="button"
        onClick={onUnlock}
        data-testid="chat-keepsake-composer"
        aria-label="Chat freischalten — Premium"
        className="relative flex min-h-[56px] w-full min-w-0 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 text-base text-muted-foreground md:text-sm">
          Dein Verlauf bleibt. Zum Weiterschreiben Chat freischalten.
        </span>
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-secondary text-secondary-foreground opacity-50"
        >
          <Send className="h-5 w-5" />
        </span>
        <KeepsakeLockBadge className="right-1 top-1" />
      </button>
    </div>
  )
}
