import type { Message } from "@/lib/types"

/**
 * Static example transcript for the T12 gated `/chat` page.
 *
 * Rules this content is held to (binding, from the T12 brief):
 *
 * - **Capability-true.** Every answer here is something the paid chat genuinely does
 *   today: general hair-care guidance grounded in the reader's own routine and profile.
 *   No claim about scans, no verdict explanation, nothing the product cannot deliver
 *   the moment the reader pays.
 * - **Short.** Two turns. The example sells the conversation, not a wall of text.
 * - **Conservative.** No mechanism claims the evidence does not carry (see the repo's
 *   "do not present weak evidence as a hard rule" convention) — the answers stay on
 *   product order, timing and dosage.
 *
 * `created_at` is deliberately empty: `ChatMessage` only renders a timestamp when the
 * field is truthy, and a fixed timestamp formatted with `format(..., "HH:mm")` would
 * render in the SERVER's timezone during SSR and the VIEWER's on hydration — a
 * guaranteed hydration mismatch on a page whose whole job is to be static.
 */

const EXAMPLE_CONVERSATION_ID = "example-conversation"

function message(input: { id: string; role: "user" | "assistant"; content: string }): Message {
  return {
    id: input.id,
    conversation_id: EXAMPLE_CONVERSATION_ID,
    role: input.role,
    content: input.content,
    product_recommendations: null,
    message_context: null,
    token_usage: null,
    langfuse_trace_id: null,
    langfuse_trace_url: null,
    user_feedback_score: null,
    user_feedback_at: null,
    created_at: "",
  }
}

export const GATED_CHAT_EXAMPLE_MESSAGES: Message[] = [
  message({
    id: "example-1",
    role: "user",
    content: "Wie oft soll ich die Maske nehmen?",
  }),
  message({
    id: "example-2",
    role: "assistant",
    content:
      "1× pro Woche reicht für deine Längen — und immer **statt** des Conditioners, nicht zusätzlich. Zusammen wird es schnell schwer.\n\nNur Längen und Spitzen, die Kopfhaut lässt du aus.",
  }),
  message({
    id: "example-3",
    role: "user",
    content: "Und wenn die Längen trotzdem trocken wirken?",
  }),
  message({
    id: "example-4",
    role: "assistant",
    content:
      "Dann liegt es meistens am Leave-in: Es gehört ins handtuchfeuchte Haar, nicht ins trockene.\n\nProbier das zwei Wochen. Wenn sich nichts ändert, sag Bescheid — dann gehen wir deine Routine der Reihe nach durch.",
  }),
]
