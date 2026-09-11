"use client"

import { useState } from "react"
import { Check, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ProductLookupIntakeReviewResolution } from "@/lib/chat/product-lookup-selection-ui"
import { getProductDisplayName } from "@/lib/product-display-name"
import type { ProductLookupClarification, ProductLookupSelectionContext } from "@/lib/types"
import { ProductImage } from "./product-image"
import { ProductIntakeCard, ProductIntakeSubmittedState } from "./product-intake-card"

type ProductLookupClarificationCardProps = {
  clarification: ProductLookupClarification
  conversationId: string
  onSelectProduct?: (params: {
    clarificationId: string
    selectedProductId: string
    sourceAssistantMessageId?: string
  }) => Promise<void> | void
  assistantMessageId?: string
  selectionDisabled?: boolean
  resolvedSelection?: ProductLookupSelectionContext | null
  resolvedIntakeReview?: ProductLookupIntakeReviewResolution | null
  onIntakeSubmitted?: (result: {
    status: "pending_review" | "matched"
    submissionId: string | null
    matchedProductId: string | null
  }) => void
  /**
   * PR5 review fix (Z4): keepsake history. The candidates stay visible — they are part of
   * the conversation the user is re-reading — but „Auswählen" is inert and the
   * „none"-action intake form (a `POST /api/product-intake`, 403 for this cohort) is not
   * offered at all. Defaults to `false`: premium and flag-off are unchanged.
   */
  readOnly?: boolean
}

export function ProductLookupClarificationCard({
  clarification,
  conversationId,
  onSelectProduct,
  assistantMessageId,
  selectionDisabled = false,
  resolvedSelection = null,
  resolvedIntakeReview = null,
  onIntakeSubmitted,
  readOnly = false,
}: ProductLookupClarificationCardProps) {
  const [showIntake, setShowIntake] = useState(false)
  const [selectingProductId, setSelectingProductId] = useState<string | null>(null)
  const [submittedProductId, setSubmittedProductId] = useState<string | null>(null)
  const persistedIntakeStatus = clarification?.none_action?.product_intake_offer?.submitted_status
  const [submittedIntakeStatus, setSubmittedIntakeStatus] = useState<
    "pending_review" | "matched" | null
  >(persistedIntakeStatus ?? null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const selectedProductId =
    resolvedSelection?.clarification_id === clarification.id
      ? resolvedSelection.selected_product_id
      : null
  const intakeLockStatus: "pending_review" | "matched" | null = resolvedIntakeReview
    ? "matched"
    : submittedIntakeStatus
  const hasLockedSelection = Boolean(
    selectedProductId ||
    submittedProductId ||
    selectingProductId ||
    submittedIntakeStatus ||
    resolvedIntakeReview,
  )

  const canSelect =
    !readOnly &&
    Boolean(onSelectProduct) &&
    Boolean(conversationId) &&
    Boolean(assistantMessageId) &&
    !assistantMessageId?.startsWith("temp-") &&
    !selectionDisabled &&
    !hasLockedSelection

  if (
    !clarification?.id ||
    !clarification.copy?.prompt_de ||
    !Array.isArray(clarification.candidates) ||
    clarification.candidates.length === 0 ||
    !clarification.none_action?.product_intake_offer
  ) {
    return null
  }

  async function selectProduct(productId: string) {
    if (!onSelectProduct || !canSelect || selectingProductId) return
    setSelectingProductId(productId)
    setSubmittedProductId(productId)
    setSelectionError(null)
    try {
      await onSelectProduct({
        clarificationId: clarification.id,
        selectedProductId: productId,
        sourceAssistantMessageId: assistantMessageId,
      })
    } catch (error) {
      setSelectionError(
        error instanceof Error
          ? error.message
          : "Das Produkt konnte nicht ausgewählt werden. Bitte versuche es erneut.",
      )
      setSubmittedProductId(null)
    } finally {
      setSelectingProductId(null)
    }
  }

  return (
    <div className="w-full min-w-0 rounded-2xl border border-border/80 bg-card p-4 shadow-sm">
      <p className="text-sm leading-relaxed text-foreground">{clarification.copy.prompt_de}</p>

      {intakeLockStatus ? (
        <div className="mt-3">
          <ProductIntakeSubmittedState status={intakeLockStatus} />
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {(selectedProductId || submittedProductId
            ? clarification.candidates.filter(
                (candidate) => candidate.product_id === (selectedProductId ?? submittedProductId),
              )
            : clarification.candidates
          ).map((candidate) => {
            const isSelected = candidate.product_id === selectedProductId
            const isSubmitted = candidate.product_id === submittedProductId
            const candidateDisplayName = getProductDisplayName(candidate.name, {
              brandName: candidate.brand_name,
              productLineName: candidate.product_line_name,
            })

            return (
              <div
                key={candidate.product_id}
                className={`flex min-w-0 items-center gap-3 rounded-xl border p-3 ${
                  isSelected
                    ? "border-primary/50 bg-[var(--brand-plum-ice)]"
                    : "border-border bg-background"
                }`}
              >
                <ProductImage
                  imageUrl={candidate.image_url ?? null}
                  category={candidate.category_label_de}
                  size="sm"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  {candidate.brand_name || candidate.product_line_name ? (
                    <p className="break-words text-xs leading-tight text-muted-foreground">
                      {[candidate.brand_name, candidate.product_line_name]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                  <p className="break-words text-sm font-semibold leading-snug text-[var(--text-heading)]">
                    {candidateDisplayName}
                  </p>
                  <span className="mt-1 inline-flex max-w-full items-center rounded-full bg-[var(--brand-plum-ice)] px-2 py-0.5 text-[11px] font-medium text-primary">
                    {candidate.category_label_de}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canSelect || selectingProductId !== null}
                  onClick={() => selectProduct(candidate.product_id)}
                  className="shrink-0 gap-1.5"
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {isSelected
                    ? "Ausgewählt"
                    : selectingProductId === candidate.product_id || isSubmitted
                      ? "Wird ausgewählt"
                      : "Auswählen"}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {selectionError ? (
        <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {selectionError}
        </p>
      ) : null}

      {!hasLockedSelection && !readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowIntake((value) => !value)}
          className="mt-3 w-full justify-center gap-1.5"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {clarification.none_action.label_de}
        </Button>
      ) : null}

      {showIntake && !hasLockedSelection && !readOnly ? (
        <div className="mt-3">
          <ProductIntakeCard
            offer={clarification.none_action.product_intake_offer}
            conversationId={conversationId}
            sourceMessageId={assistantMessageId}
            onSubmitted={(result) => {
              setSubmittedIntakeStatus(result.status)
              setShowIntake(false)
              onIntakeSubmitted?.(result)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
