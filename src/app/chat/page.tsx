import { Suspense } from "react"

import { ChatContainer } from "@/components/chat/chat-container"
import { GatedChatExample } from "@/components/gated-preview/gated-chat-example"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { shouldRenderGatedExample } from "@/lib/gated-preview/gate"

export const dynamic = "force-dynamic"

// T12 (freemium-scanner-first PR3): the free tier gets the framed „Beispiel" chat — a
// scripted, capability-true transcript — instead of a live `useChat` session it is not
// entitled to. Premium and flag-off render exactly today's page: the same
// `<ChatContainer />` (`shouldRenderGatedExample` fails closed to premium).
//
// Pre-boundary fix wave (F3): the suspected bundle bloat did NOT reproduce. Verified with
// two full production builds plus a live browser network capture on this exact route: a
// static import (this one) and both a plain `await import()` and a `next/dynamic()` wrapper
// inside the guard all shipped the byte-identical 30 chunks (~682 KB) for a premium `/chat`
// load. The client-reference manifest explains why — `GatedPreview`'s (and therefore
// `PremiumSheet`'s) chunk set is IDENTICAL to `ChatContainer`'s own, i.e. that code already
// ships on this route via a chunk shared for unrelated reasons, so gating the import moves
// nothing. Kept static rather than adding an import boundary for a saving that does not
// exist.
async function ChatTierSegment() {
  if (await shouldRenderGatedExample()) return <GatedChatExample />
  return <ChatContainer />
}

export default function ChatPage() {
  // PR3 Codex fix (X2): flag off must stay the literal pre-branch page — no tier call, no
  // Suspense wrapper. This is a plain (non-async) return, so it resolves synchronously and
  // stays byte-identical to today's render; `shouldRenderGatedExample` is never even called
  // in this state.
  if (!isFreemiumScannerFirstEnabled()) return <ChatContainer />

  // PR3 Codex fix (X2, controller ruling): unlike `/routine` and `/anwendung`, this page has
  // no server-side data load of its own to run the tier check alongside — `ChatContainer`
  // fetches its conversation list client-side, so there is nothing here to `Promise.all` the
  // tier check against. Serializing `await shouldRenderGatedExample()` ahead of the return
  // therefore added pure latency (one `auth.getUser()` plus the paid-access composite) in
  // front of every premium render, with base (pre-T12) rendering `<ChatContainer />`
  // immediately.
  //
  // Fix: stream the tier-resolved segment behind a Suspense boundary instead of awaiting it
  // in the page body. The page shell renders immediately; `ChatLayout`
  // (`src/app/chat/layout.tsx`) and everything else on the route starts sending HTML right
  // away, and the tier segment (identical `<ChatContainer />` DOM for premium, or
  // `<GatedChatExample />` for free) streams in once resolved. `ChatTierSegment` is an async
  // Server Component, not a client boundary, so there is no client-side hydration mismatch —
  // Suspense-for-Server-Components streams replacement HTML rather than re-rendering on the
  // client. The fallback is a no-op (`null`): `app/chat/loading.tsx` already owns the
  // route-level skeleton for a slow full navigation, so this inner boundary — which only
  // covers the fast tier composite on an already-visible shell — doesn't need a second,
  // competing skeleton that would only flash.
  return (
    <Suspense fallback={null}>
      <ChatTierSegment />
    </Suspense>
  )
}
