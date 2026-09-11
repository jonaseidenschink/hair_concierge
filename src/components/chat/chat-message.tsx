"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { format } from "date-fns"
import { trackAppEvent } from "@/lib/analytics/track-app-event"
import type { Message, Product, HairProfile, ProductLookupSelectionContext } from "@/lib/types"
import type { Components } from "react-markdown"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ProductPopover } from "./product-popover"
import { CombIcon } from "@/components/ui/comb-icon"
import { ProductCard } from "./product-card"
import { ProductIntakeCard } from "./product-intake-card"
import { ProductLookupClarificationCard } from "./product-lookup-clarification-card"
import type { ProductIntakeSubmissionPatch, ProductSelectionParams } from "@/hooks/use-chat"
import type {
  ProductIntakeOfferState,
  ProductLookupClarificationState,
} from "@/lib/chat/product-lookup-selection-ui"

interface ChatMessageProps {
  message: Message
  hairProfile: HairProfile | null
  onProductClick?: (product: Product) => void
  onSelectProductCandidate?: (params: ProductSelectionParams) => Promise<void> | void
  onFeedback?: (messageId: string, score: -1 | 1) => Promise<void>
  /** True for messages appended during this session (not history loads) */
  isNew?: boolean
  isStreamingMessage?: boolean
  resolvedProductLookupSelection?: ProductLookupSelectionContext | null
  productLookupClarificationState?: ProductLookupClarificationState | null
  productIntakeOfferState?: ProductIntakeOfferState | null
  onProductIntakeSubmitted?: (patch: ProductIntakeSubmissionPatch) => void
  /**
   * PR5 review fix (Z4): keepsake mode — a LAPSED owner is READING their own history. The
   * container already withholds the mutation callbacks, but the two interactive cards
   * inside a historical message do their own writes: the clarification card's „Auswählen"
   * called a handler that throws for this cohort, and both intake forms POST
   * `/api/product-intake`, which answers 403. They render as static history here: the
   * candidates and the offer stay visible, every control that would fail is gone.
   *
   * Defaults to `false`, so premium and flag-off render byte-identically to today.
   */
  keepsake?: boolean
}

/**
 * Scans text nodes for product name matches and wraps them in clickable buttons.
 */
function renderWithProductMentions(
  nodes: ReactNode[],
  productMap: Map<string, Product>,
  hairProfile: HairProfile | null,
  onProductClick?: (product: Product) => void,
): ReactNode[] {
  if (productMap.size === 0 || !onProductClick) return nodes

  const result: ReactNode[] = []

  for (const node of nodes) {
    if (typeof node !== "string") {
      result.push(node)
      continue
    }

    // Try to find product names in text, sorted by length (longest first to avoid partial matches)
    const names = Array.from(productMap.keys()).sort((a, b) => b.length - a.length)
    let remaining = node
    let key = 0

    while (remaining.length > 0) {
      let earliest = -1
      let matchedName = ""

      for (const name of names) {
        const idx = remaining.indexOf(name)
        if (idx !== -1 && (earliest === -1 || idx < earliest)) {
          earliest = idx
          matchedName = name
        }
      }

      if (earliest === -1) {
        result.push(remaining)
        break
      }

      // Push text before the match
      if (earliest > 0) {
        result.push(remaining.slice(0, earliest))
      }

      // Push the clickable product mention wrapped in popover
      const product = productMap.get(matchedName)!
      result.push(
        <ProductPopover
          key={`pm-${key++}`}
          product={product}
          hairProfile={hairProfile}
          onProductClick={onProductClick}
        >
          <button
            type="button"
            onClick={() => onProductClick(product)}
            className="inline font-semibold text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:text-primary/80 hover:decoration-primary/60"
          >
            {matchedName}
          </button>
        </ProductPopover>,
      )

      remaining = remaining.slice(earliest + matchedName.length)
    }
  }

  return result
}

/**
 * Processes React children and wraps product mentions.
 * Custom markdown components call this at their own boundary, so React elements
 * are left alone to avoid re-processing product mention buttons inside bold or
 * italic text.
 */
function processChildren(
  children: ReactNode,
  productMap: Map<string, Product>,
  hairProfile: HairProfile | null,
  onProductClick?: (product: Product) => void,
): ReactNode {
  if (typeof children === "string") {
    return renderWithProductMentions([children], productMap, hairProfile, onProductClick)
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      const processed = processChildren(child, productMap, hairProfile, onProductClick)
      // Wrap arrays in a span for valid React keys
      if (Array.isArray(processed)) {
        return <span key={i}>{processed}</span>
      }
      return processed
    })
  }
  return children
}

function normalizeAssistantMarkdown(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/([^\n])\s+(\d+\.\s+(?=(?:\*\*)?[\p{L}]))/gu, "$1\n$2")
    .replace(/([:.])\n(\d+\.\s+)/g, "$1\n\n$2")
}

export function ChatMessage({
  message,
  hairProfile,
  onProductClick,
  onSelectProductCandidate,
  onFeedback,
  isNew,
  isStreamingMessage = false,
  resolvedProductLookupSelection = null,
  productLookupClarificationState = null,
  productIntakeOfferState = null,
  onProductIntakeSubmitted,
  keepsake = false,
}: ChatMessageProps) {
  const isUser = message.role === "user"

  const displayContent = useMemo(
    () => (isUser ? (message.content ?? "") : normalizeAssistantMarkdown(message.content ?? "")),
    [isUser, message.content],
  )

  // Build product name -> Product map for inline mentions
  const products: Product[] = message.product_recommendations ?? []
  const productMap = new Map(products.map((p) => [p.name, p]))

  // Track product recommendation shown event (fire once per message)
  const trackedRef = useRef(false)
  useEffect(() => {
    if (products.length > 0 && !trackedRef.current) {
      trackedRef.current = true
      trackAppEvent("chat_product_recommendation_shown", { productCount: products.length })
    }
  }, [products.length])

  const [showAllProducts, setShowAllProducts] = useState(false)
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false)
  const visibleProducts = showAllProducts ? products : products.slice(0, 3)

  const selectProductFromClarification = async (params: {
    clarificationId: string
    selectedProductId: string
    sourceAssistantMessageId?: string
  }) => {
    if (!onSelectProductCandidate) {
      throw new Error("Produktauswahl ist gerade nicht verfügbar.")
    }
    await onSelectProductCandidate({
      conversationId: message.conversation_id,
      assistantMessageId: params.sourceAssistantMessageId ?? message.id,
      clarificationId: params.clarificationId,
      selectedProductId: params.selectedProductId,
    })
  }

  const hasEnhancements = productMap.size > 0

  const renderInline = (children: ReactNode) =>
    hasEnhancements ? processChildren(children, productMap, hairProfile, onProductClick) : children

  // Build custom markdown components that inject product mentions.
  const markdownComponents: Components = {
    p({ children }) {
      return <p className="mb-3 whitespace-pre-line last:mb-0">{renderInline(children)}</p>
    },
    ol({ children }) {
      return <ol className="my-3 list-decimal space-y-2 pl-6 first:mt-0 last:mb-0">{children}</ol>
    },
    ul({ children }) {
      return <ul className="my-3 list-disc space-y-2 pl-6 first:mt-0 last:mb-0">{children}</ul>
    },
    li({ children }) {
      return <li className="pl-1 leading-relaxed">{renderInline(children)}</li>
    },
    strong({ children }) {
      return <strong className="font-semibold">{renderInline(children)}</strong>
    },
    em({ children }) {
      return <em>{renderInline(children)}</em>
    },
  }

  return (
    <div
      data-testid={isUser ? "message-user" : "message-assistant"}
      className={`flex min-w-0 gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}${isNew ? " animate-fade-in-up-fast" : ""}`}
    >
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          isUser
            ? "bg-secondary text-[var(--brand-plum-darkest)]"
            : "bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(var(--brand-plum-rgb),0.25)]"
        }`}
      >
        {isUser ? "Du" : <CombIcon className="h-4 w-4 text-primary-foreground" />}
      </div>

      {/* Content */}
      <div
        className={`flex min-w-0 max-w-[80%] flex-col space-y-2 ${isUser ? "items-end" : "items-start"}`}
      >
        {/* Text content */}
        {message.content && (
          <div
            className={`max-w-full overflow-hidden rounded-2xl px-4 py-2.5 shadow-sm ${
              isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
            }`}
          >
            {isUser ? (
              <p className="type-body-sm whitespace-pre-wrap break-words">{message.content}</p>
            ) : (
              <div className="prose prose-sm max-w-none break-words leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {displayContent}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {message.message_context?.product_intake_offer &&
        !message.message_context?.product_lookup_clarification &&
        !isUser ? (
          <ProductIntakeCard
            offer={message.message_context.product_intake_offer}
            conversationId={message.conversation_id}
            sourceMessageId={message.id}
            persistedState={productIntakeOfferState}
            readOnly={keepsake}
            onSubmitted={(result) =>
              onProductIntakeSubmitted?.({
                messageId: message.id,
                offerId: message.message_context?.product_intake_offer?.id ?? "",
                submissionId: result.submissionId,
                status: result.status,
              })
            }
          />
        ) : null}

        {message.message_context?.product_lookup_clarification && !isUser ? (
          <ProductLookupClarificationCard
            clarification={message.message_context.product_lookup_clarification}
            conversationId={message.conversation_id}
            assistantMessageId={message.id}
            selectionDisabled={isStreamingMessage}
            readOnly={keepsake}
            resolvedSelection={
              productLookupClarificationState?.resolvedSelection ?? resolvedProductLookupSelection
            }
            resolvedIntakeReview={productLookupClarificationState?.resolvedIntakeReview ?? null}
            onSelectProduct={keepsake ? undefined : selectProductFromClarification}
            onIntakeSubmitted={(result) =>
              onProductIntakeSubmitted?.({
                messageId: message.id,
                offerId:
                  message.message_context?.product_lookup_clarification?.none_action
                    .product_intake_offer.id ?? "",
                submissionId: result.submissionId,
                status: result.status,
              })
            }
          />
        ) : null}

        {/* Product recommendation cards */}
        {products.length > 0 &&
          onProductClick &&
          !message.message_context?.product_lookup_clarification && (
            <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 pt-1">
              {visibleProducts.map((p, i) => (
                <div
                  key={p.id}
                  className="min-w-0 animate-fade-in-up-fast"
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  <ProductCard product={p} onClick={onProductClick} />
                </div>
              ))}
              {products.length > 3 && !showAllProducts && (
                <button
                  type="button"
                  onClick={() => setShowAllProducts(true)}
                  className="type-caption text-primary hover:underline text-left px-1"
                >
                  +{products.length - 3} weitere Empfehlungen
                </button>
              )}
            </div>
          )}

        {/* Timestamp */}
        {message.created_at && (
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span className="type-caption text-muted-foreground">
              {format(new Date(message.created_at), "HH:mm")}
            </span>
            {!isUser && onFeedback && !message.id.startsWith("temp-") ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={async () => {
                    setIsSubmittingFeedback(true)
                    try {
                      await onFeedback(message.id, 1)
                    } finally {
                      setIsSubmittingFeedback(false)
                    }
                  }}
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                    message.user_feedback_score === 1
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                  aria-label="Antwort positiv bewerten"
                  disabled={isSubmittingFeedback}
                >
                  <ThumbsUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setIsSubmittingFeedback(true)
                    try {
                      await onFeedback(message.id, -1)
                    } finally {
                      setIsSubmittingFeedback(false)
                    }
                  }}
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                    message.user_feedback_score === -1
                      ? "bg-rose-500/10 text-rose-700"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                  aria-label="Antwort negativ bewerten"
                  disabled={isSubmittingFeedback}
                >
                  <ThumbsDown className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
