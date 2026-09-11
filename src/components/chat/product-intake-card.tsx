"use client"

import { useId, useMemo, useState } from "react"
import { CheckCircle2 } from "lucide-react"
import {
  PRODUCT_CATEGORY_DISPLAY_LABELS,
  SUPPORTED_PRODUCT_CATEGORY_KEYS,
} from "@/lib/product-identity"
import { Button } from "@/components/ui/button"
import {
  ProductIntakeBrandProductFields,
  ProductIntakeImageFields,
  ProductIntakeMethodToggle,
} from "@/components/product-intake/product-intake-form-fields"
import {
  buildProductIntakeSubmissionPayload,
  canSubmitProductIntake,
  selectedProductIntakeBrandOptionForText,
  uploadProductIntakeImage,
  type ProductIntakeImageKind,
  type ProductIntakeMethod,
  type ProductIntakeResponseBody,
} from "@/lib/product-intake/client"
import { PRODUCT_FREQUENCY_OPTIONS, type ProductFrequency } from "@/lib/vocabulary"
import { useProductIntakeBrandOptions } from "@/hooks/use-product-intake-brand-options"
import type { ProductIntakeOfferState } from "@/lib/chat/product-lookup-selection-ui"
import type { ProductIntakeCategoryKey, ProductIntakeOffer } from "@/lib/types"

type ProductIntakeCardProps = {
  offer: ProductIntakeOffer
  conversationId: string
  sourceMessageId?: string | null
  persistedState?: ProductIntakeOfferState | null
  onSubmitted?: (result: {
    status: ProductIntakeSubmittedStatus
    submissionId: string | null
    matchedProductId: string | null
  }) => void
  /**
   * PR5 review fix (Z4): keepsake history. This form's submit is a
   * `POST /api/product-intake`, which answers 403 for a LAPSED owner — so in their history
   * it renders as a static note of what was asked, with no fields and no request path at
   * all. Defaults to `false`: premium and flag-off render byte-identically to today.
   */
  readOnly?: boolean
}

type ProductIntakeSubmittedStatus = "pending_review" | "matched"

export function ProductIntakeCard({
  offer,
  conversationId,
  sourceMessageId,
  persistedState,
  onSubmitted,
  readOnly = false,
}: ProductIntakeCardProps) {
  const brandListId = useId()
  const [method, setMethod] = useState<ProductIntakeMethod>(offer.intake_method ?? "photo")
  const [category, setCategory] = useState<ProductIntakeCategoryKey | "">(offer.category ?? "")
  const [frequency, setFrequency] = useState<ProductFrequency | "">(offer.frequency_range ?? "")
  const [brandText, setBrandText] = useState(offer.extracted_identity?.brand_text ?? "")
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null)
  const [selectedProductLineId, setSelectedProductLineId] = useState<string | null>(null)
  const [productName, setProductName] = useState(offer.extracted_identity?.product_name_text ?? "")
  const [frontImagePath, setFrontImagePath] = useState<string | null>(null)
  const [barcodeImagePath, setBarcodeImagePath] = useState<string | null>(null)
  const [frontImageValidationStatus, setFrontImageValidationStatus] = useState<string | null>(null)
  const [frontImageValidationMetadata, setFrontImageValidationMetadata] = useState<
    Record<string, unknown>
  >({})
  const [barcodeImageValidationStatus, setBarcodeImageValidationStatus] = useState<string | null>(
    null,
  )
  const [barcodeImageValidationMetadata, setBarcodeImageValidationMetadata] = useState<
    Record<string, unknown>
  >({})
  const brandOptions = useProductIntakeBrandOptions(brandText)
  const [busy, setBusy] = useState<ProductIntakeImageKind | "submit" | null>(null)
  const [submittedStatus, setSubmittedStatus] = useState<ProductIntakeSubmittedStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const missingFields = useMemo(() => offer.missing_fields ?? [], [offer.missing_fields])
  const hasMissingField = (needle: string) =>
    missingFields.some((field) => field.toLocaleLowerCase("de").includes(needle))
  const needsBrand = hasMissingField("brand") || hasMissingField("marke")
  const needsProductName =
    hasMissingField("product name") ||
    hasMissingField("product_name") ||
    hasMissingField("produktname")
  const needsBarcodeImage = hasMissingField("barcode") || hasMissingField("ean")
  const needsFrontImage = hasMissingField("front") || hasMissingField("vorderseite")
  const missingFieldLabels = uniqueMissingFieldLabels(missingFields)

  const ready = useMemo(
    () =>
      canSubmitProductIntake({
        method,
        category,
        frequency,
        brandText,
        productName,
        frontImagePath,
        committedFrontImagePath: offer.committed_front_image_path,
        barcodeImagePath,
        committedBarcodeImagePath: offer.committed_barcode_image_path,
        existingUsageId: offer.existing_usage_id,
        missingFields,
      }),
    [
      brandText,
      barcodeImagePath,
      category,
      frequency,
      frontImagePath,
      method,
      missingFields,
      offer.committed_barcode_image_path,
      offer.committed_front_image_path,
      offer.existing_usage_id,
      productName,
    ],
  )

  const inputClassName =
    "w-full rounded-xl border border-border bg-background px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-[var(--brand-plum)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--brand-plum)]/25"
  const missingInputClassName =
    "w-full rounded-xl border border-secondary/60 bg-[var(--brand-coral-light)] px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-secondary focus:outline-none focus:ring-1 focus:ring-secondary/25"
  const categoryClassName = hasMissingField("category") ? missingInputClassName : inputClassName
  const frequencyClassName =
    hasMissingField("frequency") || hasMissingField("häufig")
      ? missingInputClassName
      : inputClassName
  const imageFieldClassName =
    "block rounded-xl border border-border/80 bg-background px-3 py-3 text-sm text-foreground transition-colors"
  const missingImageFieldClassName =
    "block rounded-xl border border-secondary/60 bg-[var(--brand-coral-light)] px-3 py-3 text-sm text-foreground transition-colors"

  function handleBrandTextChange(value: string) {
    setBrandText(value)
    const selectedOption = selectedProductIntakeBrandOptionForText(brandOptions, value)
    setSelectedBrandId(selectedOption?.brand_id ?? null)
    setSelectedProductLineId(selectedOption?.product_line_id ?? null)
  }

  async function uploadImage(kind: ProductIntakeImageKind, file: File | undefined) {
    if (!file) return
    setBusy(kind)
    setError(null)

    try {
      const upload = await uploadProductIntakeImage(kind, file)

      if (kind === "front") {
        setFrontImagePath(upload.path)
        setFrontImageValidationStatus(upload.validationStatus)
        setFrontImageValidationMetadata(upload.validationMetadata)
      } else {
        setBarcodeImagePath(upload.path)
        setBarcodeImageValidationStatus(upload.validationStatus)
        setBarcodeImageValidationMetadata(upload.validationMetadata)
      }
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Bild konnte nicht hochgeladen werden.",
      )
    } finally {
      setBusy(null)
    }
  }

  async function submit(replaceExistingConfirmed = false): Promise<void> {
    if (!ready || busy) return
    setBusy("submit")
    setError(null)

    if (!category || !frequency) {
      setBusy(null)
      return
    }

    const payload = buildProductIntakeSubmissionPayload({
      method,
      category,
      frequency,
      brandText,
      brandId: selectedBrandId,
      productLineId: selectedProductLineId,
      productName,
      frontImagePath,
      frontImageValidationStatus,
      frontImageValidationMetadata,
      barcodeImagePath,
      barcodeImageValidationStatus,
      barcodeImageValidationMetadata,
      sourceConversationId: conversationId,
      sourceMessageId:
        sourceMessageId && !sourceMessageId.startsWith("temp-") ? sourceMessageId : null,
      offerId: offer.id,
      existingUsageId: offer.existing_usage_id,
      existingSubmissionId: offer.submission_id,
      replaceExistingConfirmed,
    })

    try {
      const response = await fetch("/api/product-intake/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as ProductIntakeResponseBody

      if (response.status === 409 && body.code === "product_category_already_filled") {
        const confirmed = window.confirm(
          body.error ??
            "Du hast für diese Kategorie bereits ein Produkt hinterlegt. Möchtest du es ersetzen?",
        )
        if (confirmed) {
          await submit(true)
        }
        return
      }

      if (!response.ok) {
        throw new Error(body.error ?? "Produkt konnte nicht gespeichert werden.")
      }

      const nextStatus = body.status === "matched" ? "matched" : "pending_review"
      setSubmittedStatus(nextStatus)
      onSubmitted?.({
        status: nextStatus,
        submissionId: body.submission?.id ?? body.usage?.product_submission_id ?? null,
        matchedProductId: body.matched_product_id ?? body.usage?.product_id ?? null,
      })
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Produkt konnte nicht gespeichert werden.",
      )
    } finally {
      setBusy(null)
    }
  }

  if (persistedState?.resolvedIntakeReview) {
    return <ProductIntakeSubmittedState status="matched" />
  }

  // Z4: a historical, un-submitted offer for a keepsake reader. Everything below this
  // point is a live form whose only outcome would be a 403.
  if (readOnly && !submittedStatus && !persistedState?.submittedStatus) {
    return <ProductIntakeKeepsakeState />
  }

  const effectiveSubmittedStatus = submittedStatus ?? persistedState?.submittedStatus ?? null
  if (effectiveSubmittedStatus) {
    return <ProductIntakeSubmittedState status={effectiveSubmittedStatus} />
  }

  return (
    <div className="w-full min-w-0 rounded-2xl border border-border/80 bg-card p-4 shadow-sm">
      {offer.reason === "needs_more_info" ? (
        <p className="mb-3 text-sm leading-relaxed text-foreground">
          Wir brauchen noch eine Ergänzung, damit wir dein Produkt sauber prüfen können.
        </p>
      ) : null}
      {missingFieldLabels.length > 0 ? (
        <div className="mb-3 rounded-xl border border-secondary/25 bg-[var(--brand-coral-light)] px-3 py-2 text-xs leading-relaxed text-foreground">
          Ergänze bitte: {missingFieldLabels.join(", ")}
        </div>
      ) : null}
      <ProductIntakeMethodToggle value={method} onChange={setMethod} />

      <div className="space-y-3">
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as ProductIntakeCategoryKey)}
          className={categoryClassName}
        >
          <option value="">Kategorie</option>
          {SUPPORTED_PRODUCT_CATEGORY_KEYS.map((key) => (
            <option key={key} value={key}>
              {PRODUCT_CATEGORY_DISPLAY_LABELS[key]}
            </option>
          ))}
        </select>

        <select
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as ProductFrequency)}
          className={frequencyClassName}
        >
          <option value="">Häufigkeit</option>
          {PRODUCT_FREQUENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {method === "photo" ? (
          <ProductIntakeImageFields
            frontReady={Boolean(frontImagePath || offer.committed_front_image_path)}
            barcodeReady={Boolean(barcodeImagePath || offer.committed_barcode_image_path)}
            uploading={busy === "front" || busy === "barcode" ? busy : null}
            onUpload={uploadImage}
            labelClassName={imageFieldClassName}
            barcodeLabel={needsBarcodeImage ? "Barcode erforderlich" : "Barcode optional"}
            frontLabelClassName={needsFrontImage ? missingImageFieldClassName : imageFieldClassName}
            barcodeLabelClassName={
              needsBarcodeImage ? missingImageFieldClassName : imageFieldClassName
            }
          />
        ) : null}

        <ProductIntakeBrandProductFields
          brandText={brandText}
          productName={productName}
          brandOptions={brandOptions}
          brandListId={brandListId}
          brandPlaceholder={method === "manual" || needsBrand ? "Marke" : "Marke optional"}
          productPlaceholder={
            method === "manual" || needsProductName ? "Produktname" : "Produktname optional"
          }
          onBrandTextChange={handleBrandTextChange}
          onProductNameChange={setProductName}
          inputClassName={inputClassName}
          labelTextClassName="sr-only"
          brandInputClassName={needsBrand ? missingInputClassName : inputClassName}
          productInputClassName={needsProductName ? missingInputClassName : inputClassName}
        />

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <Button
          type="button"
          onClick={() => submit()}
          disabled={!ready || busy !== null}
          variant="cta"
          className="w-full"
        >
          {busy === "submit" ? "Speichern..." : "Produkt einreichen"}
        </Button>
      </div>
    </div>
  )
}

/**
 * Z4: the static stand-in for a live intake form in keepsake history — the same card
 * shape, none of its controls, and no path to a request.
 */
export function ProductIntakeKeepsakeState() {
  return (
    <div className="w-full min-w-0 rounded-2xl border border-border/80 bg-card p-4 shadow-sm">
      <p className="text-sm font-semibold text-[var(--text-heading)]">Produkt erfassen</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        Das haben wir dich damals gefragt. Nachtragen kannst du es mit wieder freigeschaltetem Chat.
      </p>
    </div>
  )
}

export function ProductIntakeSubmittedState({ status }: { status: ProductIntakeSubmittedStatus }) {
  const copy =
    status === "matched"
      ? {
          headline: "Produkt gespeichert.",
          body: "Du kannst dazu jetzt direkt weiterfragen.",
        }
      : {
          headline: "Danke, wir prüfen dein Produkt.",
          body: "Wir melden uns hier im Chat. Du kannst inzwischen einfach weiterfragen.",
        }

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full min-w-0 rounded-2xl border border-emerald-200 bg-card p-5 shadow-sm animate-fade-in-up-fast"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"
          aria-hidden="true"
        >
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text-heading)]">{copy.headline}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
        </div>
      </div>
    </div>
  )
}

function uniqueMissingFieldLabels(fields: string[]) {
  const labels = fields.map(formatMissingFieldLabel)
  return labels.filter((label, index) => labels.indexOf(label) === index)
}

function formatMissingFieldLabel(field: string) {
  const normalized = field.toLocaleLowerCase("de")
  if (normalized.includes("barcode") || normalized.includes("ean")) return "Barcodefoto"
  if (normalized.includes("front") || normalized.includes("vorderseite")) return "Vorderseitenfoto"
  if (
    normalized.includes("product name") ||
    normalized.includes("product_name") ||
    normalized.includes("produktname")
  ) {
    return "Produktname"
  }
  if (normalized.includes("brand") || normalized.includes("marke")) return "Marke"
  if (normalized.includes("category") || normalized.includes("kategorie")) return "Kategorie"
  if (normalized.includes("frequency") || normalized.includes("häufig")) {
    return "Nutzungshäufigkeit"
  }
  return field
}
