import Image from "next/image"
import type { ReactNode } from "react"

import { TEXTURE_OPTIONS, type PersonalPlanTexture } from "./texture-question"
import { cn } from "@/lib/utils"

export const PERSONAL_PLAN_SECTION_LABELS = ["Profil", "Ziele", "Analyse", "Plan", "Ergebnis"]

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="m12 19-7-7 7-7M19 12H5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

export function PersonalPlanQuizFieldTestBanner({ surface }: { surface: "quiz" | "offer" }) {
  return (
    <p
      className="mx-auto w-full max-w-[40rem] rounded-xl border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] px-4 py-2 text-center text-sm font-semibold text-[var(--brand-plum-darkest)]"
      data-personal-plan-field-test-banner={surface}
    >
      Kostenloser Chaarlie Produkttest · keine Zahlung erforderlich
    </p>
  )
}

export function PersonalPlanQuizFrame({
  canGoBack,
  children,
  clientReady,
  currentSectionIndex,
  fieldTest,
  onBack,
  progress,
  settledSectionIndices,
}: {
  canGoBack: boolean
  children: ReactNode
  clientReady: boolean
  currentSectionIndex: number
  fieldTest: boolean
  onBack: () => void
  progress: number
  settledSectionIndices: ReadonlySet<number>
}) {
  return (
    <div
      className="min-h-screen bg-[hsl(var(--background))]"
      data-personal-plan-client-ready={clientReady ? "true" : "false"}
    >
      <header className="sticky top-0 z-30 border-b border-[var(--brand-plum-light)] bg-[hsl(var(--background))]/95 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="mx-auto grid max-w-[44rem] grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center">
          <button
            aria-label="Zurück"
            aria-hidden={!canGoBack}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full bg-white text-[var(--brand-plum-darkest)] shadow-sm ring-1 ring-black/5 transition hover:bg-[var(--brand-plum-ice)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum)] sm:h-11 sm:w-11",
              !canGoBack && "pointer-events-none opacity-0",
            )}
            disabled={!canGoBack}
            onClick={onBack}
            tabIndex={canGoBack ? 0 : -1}
            type="button"
          >
            <ArrowLeftIcon />
          </button>
          <span className="justify-self-center font-header text-xl font-medium text-[var(--brand-plum-darkest)]">
            chaarlie
          </span>
          <span aria-hidden="true" />
        </div>
        <div className="mx-auto mt-2 max-w-[44rem]" aria-label="Fortschritt">
          <div className="relative h-2" data-layout="progress-track-with-dots">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--brand-plum-light)]">
              <div
                className="h-full rounded-full bg-[var(--brand-plum)] transition-[width] duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 grid grid-cols-5 gap-1"
              data-layout="progress-dot-overlay"
            >
              {PERSONAL_PLAN_SECTION_LABELS.map((label, index) => {
                const state =
                  index < currentSectionIndex
                    ? "done"
                    : index === currentSectionIndex
                      ? "current"
                      : "todo"
                return (
                  <span className="flex items-center justify-center" key={label}>
                    <span
                      data-personal-plan-section-settled={
                        settledSectionIndices.has(index) ? "true" : undefined
                      }
                      className={cn(
                        "h-2 w-2 rounded-full ring-2 ring-[hsl(var(--background))] transition-[background-color,box-shadow] duration-300 ease-out",
                        settledSectionIndices.has(index) && "personal-plan-section-settle",
                        state === "done" && "bg-[var(--brand-plum)]",
                        state === "current" &&
                          "bg-[var(--brand-plum)] shadow-[0_0_0_3px_rgba(var(--brand-plum-rgb),0.14)]",
                        state === "todo" && "bg-[var(--brand-plum-light)]",
                      )}
                    />
                  </span>
                )
              })}
            </div>
          </div>
          <ol className="mt-1 grid grid-cols-5 gap-1">
            {PERSONAL_PLAN_SECTION_LABELS.map((label, index) => {
              const state =
                index < currentSectionIndex
                  ? "done"
                  : index === currentSectionIndex
                    ? "current"
                    : "todo"
              return (
                <li className="flex items-center justify-center" key={label}>
                  <span
                    className={cn(
                      "text-[8px] font-semibold uppercase tracking-[0.04em] sm:text-[9px]",
                      state === "todo"
                        ? "text-[var(--text-caption)]"
                        : "text-[var(--brand-plum-darkest)]",
                    )}
                  >
                    {label}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </header>
      <main className="flex min-h-[calc(100dvh-84px)] scroll-pb-[calc(7rem+env(safe-area-inset-bottom))] items-start px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-5 sm:items-center sm:px-6 sm:py-12 [@media(max-height:700px)]:items-start [@media(max-height:700px)]:pb-[calc(6rem+env(safe-area-inset-bottom))] [@media(max-height:700px)]:pt-4 [@media(min-width:640px)_and_(min-height:701px)]:scroll-pb-12 [@media(min-width:640px)_and_(min-height:701px)]:pb-12">
        <div className="w-full">
          {fieldTest ? <PersonalPlanQuizFieldTestBanner surface="quiz" /> : null}
          <div className={fieldTest ? "mt-4" : undefined}>{children}</div>
        </div>
      </main>
    </div>
  )
}

function TextureCheck() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
      <path
        d="m20 6-11 11-5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

/**
 * Freemium scanner-first (T18): the deal is stated once, at the quiz intro —
 * never as a teaser on the e-mail screen (journey sign-off).
 */
export const PERSONAL_PLAN_QUIZ_EXPECTATION_LINE =
  "Am Ende: dein Haarprofil, und du kannst jedes Produkt scannen — gratis."

export function PersonalPlanQuizTextureQuestion({
  expectationLine = false,
  onSelect,
  recoveryVisible = false,
  selected,
}: {
  expectationLine?: boolean
  onSelect: (texture: PersonalPlanTexture) => void
  recoveryVisible?: boolean
  selected?: PersonalPlanTexture
}) {
  return (
    <section className="mx-auto w-full max-w-[40rem]">
      <h1 className="text-balance text-center font-header text-[1.625rem] font-medium leading-[1.12] text-[var(--brand-plum-darkest)] sm:text-[2.4rem] [@media(max-height:700px)]:text-[1.625rem]">
        Welche Haarstruktur hast du?
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-[15px] leading-6 text-[var(--text-sub)]">
        Wähle das Bild, das deinem natürlichen Haar am nächsten kommt.
      </p>
      {expectationLine ? (
        <p
          className="mx-auto mt-2 max-w-xl text-balance text-center text-[14px] font-semibold leading-6 text-[var(--brand-plum)]"
          data-personal-plan-expectation-line
        >
          {PERSONAL_PLAN_QUIZ_EXPECTATION_LINE}
        </p>
      ) : null}
      <div className="mt-5 grid grid-cols-2 auto-rows-fr gap-3 sm:mt-7">
        {TEXTURE_OPTIONS.map((option, optionIndex) => {
          const isSelected = selected === option.value
          return (
            <button
              aria-pressed={isSelected}
              className={cn(
                "personal-plan-option-card group relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-[0_12px_34px_-28px_rgba(var(--brand-plum-rgb),0.6)] transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-plum-dark)] focus-visible:ring-offset-2",
                isSelected
                  ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] ring-2 ring-[rgba(var(--brand-plum-rgb),0.2)]"
                  : "border-[var(--brand-plum-light)] hover:-translate-y-0.5 hover:shadow-[0_14px_30px_-24px_rgba(var(--brand-plum-rgb),0.5)]",
              )}
              key={option.value}
              onClick={() => onSelect(option.value)}
              type="button"
            >
              <div className="relative h-36 w-full shrink-0 overflow-hidden bg-[var(--brand-plum-ice)] sm:aspect-[4/3] sm:h-auto [@media(max-height:700px)]:h-28">
                <Image
                  alt={option.imageAlt}
                  className="object-cover object-[center_38%] transition duration-300 group-hover:scale-[1.02]"
                  fill
                  fetchPriority={optionIndex === 0 ? "high" : "auto"}
                  preload={optionIndex === 0}
                  sizes="(max-width: 640px) 45vw, 320px"
                  src={option.image}
                />
              </div>
              <div className="flex h-11 w-full flex-none items-end gap-3 px-3 pb-2 pt-1 sm:h-auto sm:min-h-24 sm:items-start sm:p-4 [@media(max-height:700px)]:h-10 [@media(max-height:700px)]:min-h-0 [@media(max-height:700px)]:items-end [@media(max-height:700px)]:px-2.5 [@media(max-height:700px)]:pb-1.5 [@media(max-height:700px)]:pt-1">
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold leading-snug text-[var(--brand-plum-darkest)]">
                    {option.label}
                  </span>
                  <span className="mt-1 hidden text-sm leading-5 text-[var(--text-sub)] sm:block">
                    {option.description}
                  </span>
                </span>
                <span
                  className={cn(
                    "personal-plan-option-check mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                    isSelected
                      ? "border-[var(--brand-plum)] bg-[var(--brand-plum)] text-white"
                      : "border-[var(--brand-plum-light)] bg-white text-transparent",
                  )}
                >
                  <TextureCheck />
                </span>
              </div>
            </button>
          )
        })}
      </div>
      {recoveryVisible ? (
        <div
          className="mt-5 flex items-center gap-3 rounded-2xl border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] px-4 py-3 text-sm text-[var(--brand-plum-darkest)]"
          data-personal-plan-progressive-recovery
          role="status"
        >
          <span
            aria-hidden="true"
            className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[var(--brand-plum-light)] border-t-[var(--brand-plum)]"
          />
          <span>
            <strong className="font-semibold">Einen Moment – wir laden automatisch weiter.</strong>
            <span className="block text-[var(--text-sub)]">Deine Auswahl bleibt erhalten.</span>
          </span>
        </div>
      ) : null}
    </section>
  )
}

export function PersonalPlanQuizLegalLine() {
  return (
    <p className="flex items-center justify-center gap-1 pb-4 pt-1 text-xs text-muted-foreground">
      <a
        href="/impressum"
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-11 items-center px-1 transition-colors hover:text-foreground"
      >
        Impressum
      </a>
      <span aria-hidden="true">·</span>
      <a
        href="/datenschutz"
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-11 items-center px-1 transition-colors hover:text-foreground"
      >
        Datenschutz
      </a>
    </p>
  )
}
