import { notFound } from "next/navigation"

import { GatedAnwendungExample } from "@/components/gated-preview/gated-anwendung-example"
import { GatedChatExample } from "@/components/gated-preview/gated-chat-example"
import { GatedRoutineExample } from "@/components/gated-preview/gated-routine-example"

/**
 * Dev-only harness for the gated „Beispiel" pages (T11's `GatedPreview` frame + T12's
 * example compositions).
 *
 * The real gated pages need a signed-in FREE account with the freemium flag on, so this
 * is the cheapest honest way to review them in a browser at a real mobile viewport: the
 * wrapper reproduces the authenticated shell's geometry — the sticky 3.5rem header and
 * the fixed mobile bottom nav, both as inert placeholders — so the frame here is exactly
 * as tall as it will be in the app.
 *
 * `?example=routine|anwendung|chat` switches between the three compositions; they are the
 * SAME components the three routes render, not harness copies.
 *
 * Same guard as every other `/labs` page (`labs/scan/page.tsx`): a production build 404s.
 */
const EXAMPLES = {
  routine: GatedRoutineExample,
  anwendung: GatedAnwendungExample,
  chat: GatedChatExample,
} as const

type ExampleKey = keyof typeof EXAMPLES

function exampleKey(value: string | string[] | undefined): ExampleKey {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && raw in EXAMPLES ? (raw as ExampleKey) : "routine"
}

export default async function GatedPreviewLabPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NODE_ENV !== "development") notFound()

  const key = exampleKey((await searchParams).example)
  const Example = EXAMPLES[key]

  return (
    <div
      data-gated-preview-lab={key}
      className="min-h-dvh [--personal-plan-shell-bottom-padding:calc(4.5rem+env(safe-area-inset-bottom))] [--personal-plan-shell-header-offset:3.5rem]"
    >
      {/* Inert stand-in for the app header (same 3.5rem / h-14 as the real one). */}
      <header className="sticky top-0 z-40 flex h-14 items-center border-b border-border bg-background/95 px-4 backdrop-blur">
        <span className="font-header text-2xl tracking-wide text-[var(--text-heading)]">
          chaarlie
        </span>
      </header>

      <div className="pb-[var(--personal-plan-shell-bottom-padding)] md:pb-0">
        <Example />
      </div>

      {/* Inert stand-in for the mobile bottom nav. */}
      <div
        aria-hidden="true"
        className="fixed inset-x-0 bottom-0 z-50 min-h-[calc(4.5rem+env(safe-area-inset-bottom))] border-t border-border bg-background/95 backdrop-blur md:hidden"
      />
    </div>
  )
}
