import { ArrowDown, LockKeyhole } from "lucide-react"

import type {
  OfferPreviewCategory,
  OfferPreviewProductCard,
  QuizOfferPreview,
} from "@/lib/quiz/offer-preview-types"

import { OFFER_PREVIEW_CATEGORY_TITLES } from "./offer-preview-routine"

const MASK_OR_OIL_CATEGORIES = new Set<OfferPreviewCategory>([
  "protein_mask",
  "moisture_mask",
  "oil",
])

function FoundationProductCard({ product }: { product: OfferPreviewProductCard }) {
  return (
    <article
      data-testid="app-value-stack-foundation-product"
      className="flex min-h-[132px] gap-4 overflow-hidden rounded-[18px] border border-border bg-white p-4 shadow-[0_8px_30px_-26px_rgba(var(--brand-plum-rgb),0.5)]"
    >
      <div className="grid h-[100px] w-[82px] shrink-0 place-items-center overflow-hidden rounded-[12px] bg-[#F3EFE8] p-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- catalog images are hosted in the project's Supabase bucket. */}
        <img
          alt={product.name}
          className="h-full w-full object-contain"
          loading="lazy"
          src={product.imageUrl}
        />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="font-mono text-[8px] font-semibold uppercase tracking-[0.09em] text-[var(--brand-plum)]">
          {product.categoryLabel}
        </p>
        <h3 className="mt-1.5 text-[15px] font-bold leading-snug text-[var(--brand-plum-darkest)]">
          {product.name}
        </h3>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{product.note}</p>
        <p className="mt-2 text-[11px] font-semibold text-[var(--brand-plum)]">
          {product.cadence.label}
          {product.cadence.qualifier ? ` · ${product.cadence.qualifier}` : ""}
        </p>
      </div>
    </article>
  )
}

function LockedRoutineCell({ label }: { label: string }) {
  return (
    <div
      data-testid="app-value-stack-locked-cell"
      className="flex min-h-[92px] min-w-0 flex-col justify-between rounded-[16px] border border-[var(--brand-plum-light)] bg-white p-3.5"
    >
      <span className="grid size-7 place-items-center self-end rounded-full bg-[var(--brand-plum-ice)] text-[var(--brand-plum)]">
        <LockKeyhole className="size-3.5" aria-hidden="true" />
      </span>
      <span className="mt-3 break-words text-[12px] font-semibold leading-snug text-[var(--brand-plum-darkest)] [overflow-wrap:anywhere]">
        {label}
      </span>
    </div>
  )
}

export function AppValueStackRoutine({ preview }: { preview: QuizOfferPreview }) {
  const foundationProducts = preview.products.filter((product) => !product.suggested)
  const suggestedProduct = preview.products.find((product) => product.suggested)
  const firstLockedLabel = suggestedProduct
    ? OFFER_PREVIEW_CATEGORY_TITLES[suggestedProduct.category]
    : "Weitere Pflege"
  const secondLockedLabel =
    suggestedProduct && MASK_OR_OIL_CATEGORIES.has(suggestedProduct.category)
      ? "Weitere Pflege"
      : "Maske & Öle"

  return (
    <section className="border-t border-border py-9">
      <div data-offer-section="personalized_analysis">
        <h2 className="font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
          Deine Pflegebasis
        </h2>
        <p className="mt-3 text-[14px] leading-[1.65] text-muted-foreground">
          Diese drei Punkte bestimmen, womit deine Routine startet.
        </p>

        <div className="mt-6 overflow-hidden rounded-[18px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)]/55">
          <ol>
            {preview.signals.map((signal, index) => (
              <li
                key={`${signal.label}-${index}`}
                data-testid="app-value-stack-signal"
                className="flex gap-3 border-b border-[var(--brand-plum-light)] px-4 py-3.5"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white text-[12px] font-bold text-[var(--brand-plum)]">
                  {index + 1}
                </span>
                <span>
                  <strong className="block text-[13px] text-[var(--brand-plum-darkest)]">
                    {signal.label}
                  </strong>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                    {signal.conclusion}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-center gap-2 bg-white/75 px-4 py-3 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
            <ArrowDown aria-hidden="true" className="size-3.5" />
            Daraus entsteht dein Start
          </div>
        </div>

        <p className="mt-4 text-center text-[12px] leading-relaxed text-muted-foreground">
          Mit konkreten Beispielen aus unserer Produktdatenbank. Das sind noch nicht deine finalen
          Produktempfehlungen.
        </p>
      </div>

      <div data-offer-section="mini_routine" className="mt-4 space-y-3">
        {foundationProducts.map((product) => (
          <FoundationProductCard key={product.key} product={product} />
        ))}
      </div>

      <div data-offer-section="locked_routine">
        <div
          className="mt-4 grid grid-cols-3 gap-2.5"
          aria-describedby="app-value-stack-lock-explanation"
        >
          <LockedRoutineCell label={firstLockedLabel} />
          <LockedRoutineCell label={secondLockedLabel} />
          <LockedRoutineCell label="Tools" />
        </div>
        <p
          id="app-value-stack-lock-explanation"
          className="mt-3 text-[12px] leading-relaxed text-muted-foreground"
        >
          Diese Bausteine gehören zu deiner vollständigen Routine.
        </p>
      </div>
    </section>
  )
}
