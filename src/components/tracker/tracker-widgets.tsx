"use client"

import { format } from "date-fns"
import { de } from "date-fns/locale"
import { Check, PencilLine, Sparkles } from "lucide-react"

import { TRACKER_ACTIVITY_PRESENTATION_DE } from "@/lib/tracking/presentation"
import type { RhythmSummary } from "@/lib/tracking/rhythm"
import type { TrackerDayType } from "@/lib/tracking/types"
import { cn } from "@/lib/utils"

export interface WeekStripDay {
  date: string
  dayType: TrackerDayType | null
  customActivityName?: string | null
  isToday: boolean
  isFuture: boolean
  isEditable: boolean
}

function dayAriaLabel(day: WeekStripDay): string {
  const date = format(new Date(`${day.date}T00:00:00`), "EEEE, d. MMMM", { locale: de })
  if (!day.dayType) return `${date}, kein Eintrag`
  if (day.dayType === "custom") {
    return `${date}, eigene Aktivität: ${day.customActivityName ?? "ohne Namen"}`
  }
  return `${date}, ${TRACKER_ACTIVITY_PRESENTATION_DE[day.dayType].label}`
}

export function WeekStrip(props: {
  days: WeekStripDay[]
  selectedDate: string
  onSelect: (date: string) => void
}) {
  return (
    <div className="grid grid-cols-8 gap-1" role="tablist" aria-label="Letzte acht Tage">
      {props.days.map((day) => {
        const selected = day.date === props.selectedDate
        return (
          <button
            key={day.date}
            type="button"
            role="tab"
            aria-label={dayAriaLabel(day)}
            aria-selected={selected}
            disabled={day.isFuture || !day.isEditable}
            onClick={() => props.onSelect(day.date)}
            className={cn(
              "tracker-day-tab flex min-h-[66px] min-w-0 flex-col items-center justify-center rounded-[14px] border text-xs",
              selected
                ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] text-[var(--brand-plum-dark)]"
                : "border-transparent",
              day.isToday && !selected ? "bg-card" : "",
              day.isFuture || !day.isEditable
                ? "opacity-40"
                : "hover:border-[var(--brand-plum-light)] hover:bg-[var(--brand-plum-ice)]",
            )}
          >
            <span className="text-[11px] text-muted-foreground">
              {format(new Date(`${day.date}T00:00:00`), "EE", { locale: de })}
            </span>
            <span className="mt-0.5 font-medium">
              {format(new Date(`${day.date}T00:00:00`), "d")}
            </span>
            {day.dayType === "custom" ? (
              <PencilLine className="mt-1 h-3 w-3 text-[var(--brand-plum)]" aria-hidden="true" />
            ) : (
              <span
                className={cn(
                  "mt-1 h-2.5 w-2.5 rounded-full",
                  day.dayType && day.dayType !== "none"
                    ? "bg-[var(--brand-plum)]"
                    : day.dayType === "none"
                      ? "border border-[var(--brand-plum-light)] bg-background"
                      : "bg-transparent",
                )}
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

function targetCopy(summary: RhythmSummary): string | null {
  if (summary.kind !== "progress" || summary.minWashes === null || summary.maxWashes === null) {
    return summary.targetLabel
  }
  const period = summary.periodWeeks === 1 ? "pro Woche" : `in ${summary.periodWeeks} Wochen`
  return summary.minWashes === summary.maxWashes
    ? `${summary.minWashes} ${summary.minWashes === 1 ? "Wäsche" : "Wäschen"} ${period}`
    : `${summary.minWashes}–${summary.maxWashes} Wäschen ${period}`
}

export function RhythmBand(props: { summary: RhythmSummary }) {
  const summary = props.summary
  const target = targetCopy(summary)
  const headline =
    summary.kind !== "progress"
      ? "Dein persönlicher Rhythmus"
      : summary.status === "below"
        ? "Deine Woche ist noch offen"
        : summary.status === "above"
          ? "Du hast häufiger gewaschen"
          : "Du bist in deinem Rhythmus"
  const statusLabel =
    summary.kind !== "progress"
      ? null
      : summary.status === "below"
        ? "Noch offen"
        : summary.status === "above"
          ? "Über Orientierung"
          : "Im Zielbereich"
  const periodLabel = summary.periodWeeks === 1 ? "Diese Woche" : "In diesem Zeitraum"
  const continuity = summary.completedWeeklyStreak
    ? `Seit ${summary.completedWeeklyStreak} Wochen in deinem Rhythmus.`
    : null

  return (
    <section
      className="rounded-[20px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] p-4 shadow-[0_10px_32px_rgba(var(--brand-plum-rgb),0.06)] sm:p-[18px]"
      aria-labelledby="tracker-rhythm-heading"
    >
      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-plum)] text-white">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase text-[var(--brand-plum-dark)]">
            Dein Waschrhythmus
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <h2
              id="tracker-rhythm-heading"
              className="text-base font-medium text-[var(--text-heading)]"
            >
              {headline}
            </h2>
            {statusLabel ? (
              <span className="rounded-full border border-[var(--brand-plum-light)] bg-white/70 px-2 py-1 text-[10px] font-medium text-[var(--brand-plum-dark)]">
                {statusLabel}
              </span>
            ) : null}
          </div>

          {summary.kind === "progress" && summary.progress !== null ? (
            <>
              <div className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--text-sub)]">
                <span>
                  {periodLabel}: {summary.washes} {summary.washes === 1 ? "Wäsche" : "Wäschen"}
                </span>
                {summary.preferredWashes !== null ? (
                  <span className="shrink-0 font-medium text-[var(--brand-plum-dark)]">
                    {summary.washes} von ca. {Math.max(1, Math.round(summary.preferredWashes))}
                  </span>
                ) : null}
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-[rgba(var(--brand-plum-rgb),0.14)]"
                role="progressbar"
                aria-label={`${summary.washes} Wäschen, empfohlen ${target}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(summary.progress * 100)}
              >
                <div
                  className="tracker-rhythm-progress h-full origin-left rounded-full bg-[var(--brand-coral)]"
                  style={{ transform: `scaleX(${summary.progress})` }}
                />
              </div>
            </>
          ) : null}

          <p className="mt-3 text-sm leading-relaxed text-[var(--text-sub)]">
            {summary.encouragement}
          </p>
          {target && summary.kind === "progress" ? (
            <p className="mt-2 text-xs text-[var(--text-caption)]">Deine Orientierung: {target}.</p>
          ) : null}
          {continuity ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-[var(--brand-plum-dark)]">
              <Check className="h-4 w-4" aria-hidden="true" />
              {continuity}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function NudgeCard(props: { message: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border-l-2 border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] px-3 py-3 text-sm text-[var(--brand-plum-darkest)]">
      <p>{props.message}</p>
      <button
        type="button"
        onClick={props.onDismiss}
        className="mt-2 text-xs font-medium text-[var(--brand-plum-dark)] underline underline-offset-2"
      >
        Ausblenden
      </button>
    </div>
  )
}
