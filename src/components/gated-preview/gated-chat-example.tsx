"use client"

import { ChatInput } from "@/components/chat/chat-input"
import { ChatMessage } from "@/components/chat/chat-message"
import { GATED_EXAMPLE_COPY } from "@/lib/gated-preview/example-copy"
import { GATED_CHAT_EXAMPLE_MESSAGES } from "@/lib/gated-preview/fixtures/chat-example"

import { GatedPreview } from "./gated-preview"
import { InertExample } from "./inert-example"

/**
 * The free tier's `/chat` (T12).
 *
 * A scripted transcript through the real bubbles. `ChatContainer` is NOT used and not
 * imported: it is the `useChat` host — it loads the conversation list on mount, streams
 * `POST /api/chat`, submits feedback and consumes routine trigger seeds from
 * sessionStorage. What the reader needs to see is the conversation itself, so this
 * composes the two components that draw it: `ChatMessage` (the bubbles, markdown, avatar)
 * and the disabled `ChatInput` (the real composer, visibly not usable yet).
 *
 * Each `ChatMessage` is handed no `onProductClick` / `onFeedback` / `onSelectProductCandidate`
 * and a fixture with `product_recommendations: null`, which leaves the component with no
 * interactive affordance and no analytics call — its one effect only fires for messages
 * that carry product recommendations.
 *
 * The wrapper mirrors `ChatContainer`'s own message-list geometry (`mx-auto max-w-3xl
 * space-y-4 p-4`) so the bubbles sit exactly where they sit in the real chat.
 *
 * "use client" because `ChatInput` requires an `onSend` callback: a server component may
 * not hand a function across the client boundary. The whole composition is presentational
 * client UI anyway — it just never becomes interactive, because the callback does nothing
 * and `InertExample` cancels the activation before it could be reached.
 */
const NOOP_SEND = () => {}

export function GatedChatExample() {
  const copy = GATED_EXAMPLE_COPY.chat
  return (
    <GatedPreview
      feature={copy.feature}
      source={copy.source}
      exampleLabel={copy.exampleLabel}
      benefit={copy.benefit}
      cta={copy.cta}
    >
      <InertExample className="flex min-h-full flex-col">
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-0 py-1">
          {GATED_CHAT_EXAMPLE_MESSAGES.map((message) => (
            <ChatMessage key={message.id} message={message} hairProfile={null} />
          ))}
        </div>
        <div className="mt-4 [&>div]:px-0 [&>div]:pb-0 [&>div]:shadow-none">
          <ChatInput onSend={NOOP_SEND} disabled />
        </div>
      </InertExample>
    </GatedPreview>
  )
}
