import { Suspense } from "react"

import { ChatContainer } from "@/components/chat/chat-container"
import { GatedChatExample } from "@/components/gated-preview/gated-chat-example"
import { isFreemiumScannerFirstEnabled } from "@/lib/entitlements/flag"
import { resolveGatedPageMode } from "@/lib/gated-preview/gate"

export const dynamic = "force-dynamic"

type ConversationPageProps = { params: Promise<{ conversationId?: string | string[] }> }

function conversationIdFrom(params: Awaited<ConversationPageProps["params"]>): string | null {
  const raw = params.conversationId
  const value = Array.isArray(raw) ? raw[0] : raw
  return value ?? null
}

/**
 * T17 (deferral 1 from T12): the deep link into a single conversation was the one chat
 * surface T12 left ungated — `/chat` itself branched on the tier, but
 * `/chat/[conversationId]` still mounted the live `ChatContainer` for anyone middleware
 * admitted, which under the freemium flag includes free-tier users.
 *
 * The three states mirror `/chat`:
 * - `"example"` — a never-paid free user has no conversations of their own to deep-link
 *   into, so any id resolves to the same framed „Beispiel" chat `/chat` shows them.
 * - `"keepsake"` — a LAPSED owner keeps READING their own history here (middleware's
 *   method-scoped `GET /api/chat/[id]` carve-out) with the composer locked to the
 *   Premium sheet (`{feature: "chat", source: "gated:chat"}`).
 * - `"premium"` — today's page verbatim.
 *
 * This page became a Server Component to derive that server-side at all: `conversationId`
 * now comes from `params` instead of `useParams()`, which is what the client component
 * was doing purely to read the route segment.
 */
async function ConversationTierSegment({ conversationId }: { conversationId: string | null }) {
  const mode = await resolveGatedPageMode()
  if (mode === "example") return <GatedChatExample />
  if (mode === "keepsake") return <ChatContainer conversationId={conversationId} keepsake />
  return <ChatContainer conversationId={conversationId} />
}

export default async function ConversationPage({ params }: ConversationPageProps) {
  const conversationId = conversationIdFrom(await params)

  // Flag off stays the literal pre-T17 page: the same `<ChatContainer conversationId />`,
  // no tier call, no Suspense wrapper — byte-identical to today.
  if (!isFreemiumScannerFirstEnabled()) return <ChatContainer conversationId={conversationId} />

  // Same shape as `/chat` (PR3 Codex fix X2): stream the tier-resolved segment rather than
  // awaiting the paid-access composite in front of the shell, so a premium deep-link render
  // is not serialized behind one `auth.getUser()` plus the billing/moderator reads.
  // `app/chat/loading.tsx` already owns the route-level skeleton, so this inner boundary
  // uses a no-op fallback instead of a second, competing one.
  return (
    <Suspense fallback={null}>
      <ConversationTierSegment conversationId={conversationId} />
    </Suspense>
  )
}
