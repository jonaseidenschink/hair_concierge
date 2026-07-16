import Link from "next/link"
import {
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  LockKeyhole,
  LogOut,
  MessageCircleMore,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

import { OfferPreviewRoutine } from "@/components/quiz/offer-preview-routine"
import { MembershipReactivationCheckout } from "@/components/reactivation/membership-reactivation-checkout"
import { signOutAction } from "@/app/auth/actions"
import type { QuizOfferPreview } from "@/lib/quiz/offer-preview-types"
import type { BillingInterval } from "@/lib/stripe/intervals"
import { DEFAULT_PRICING_INTERVAL } from "@/lib/stripe/pricing-plans"

const benefits = [
  {
    icon: ClipboardCheck,
    title: "Deine persönliche Routine",
    text: "Auf deine Haare abgestimmt und gemeinsam mit Chaarlie weiter verfeinert.",
  },
  {
    icon: Sparkles,
    title: "Klarheit bei Produkten",
    text: "Verstehe, was zu dir passt, wie du es anwendest und was du weglassen kannst.",
  },
  {
    icon: MessageCircleMore,
    title: "Antworten, wenn du sie brauchst",
    text: "Frag Chaarlie jederzeit zu deiner Routine, Anwendung oder neuen Produkten.",
  },
] as const

const faqs = [
  {
    question: "Was wird sofort wieder freigeschaltet?",
    answer:
      "Du erhältst wieder Zugriff auf deine persönliche Routine, deine Produktempfehlungen und Chaarlie als deinen digitalen Haarpflege-Begleiter.",
  },
  {
    question: "Sind meine bisherigen Angaben noch gespeichert?",
    answer:
      "Ja. Dein Haarprofil, deine Ziele und dein bisheriger Chaarlie-Kontext bleiben erhalten, damit du nicht von vorne anfangen musst.",
  },
  {
    question: "Wann werde ich belastet?",
    answer:
      "Die erste Zahlung wird direkt bei der Reaktivierung fällig. Danach verlängert sich dein gewählter Plan automatisch im jeweiligen Abrechnungsrhythmus.",
  },
  {
    question: "Kann ich später kündigen oder den Plan ändern?",
    answer:
      "Ja. Du kannst deine Mitgliedschaft über deine Kontoeinstellungen verwalten. Die Kündigung gilt zum Ende des bereits bezahlten Zeitraums.",
  },
  {
    question: "Was, wenn ich bereits eine aktive Mitgliedschaft habe?",
    answer:
      "Dann starten wir keine zweite Mitgliedschaft. Melde dich über den Hilfe-Link, falls dein aktiver Zugang nicht korrekt erkannt wird.",
  },
] as const

export function MembershipReactivationPage({
  firstName,
  initialInterval = DEFAULT_PRICING_INTERVAL,
  returnDestination,
  routinePreview,
  showCheckout = true,
}: {
  firstName: string | null
  initialInterval?: BillingInterval
  returnDestination: string
  routinePreview: QuizOfferPreview
  showCheckout?: boolean
}) {
  return (
    <main className="min-h-screen bg-[#fbfaf8] text-[var(--brand-plum-darkest)]">
      <header className="border-b border-border/60 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <span className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-[-0.03em] text-[var(--brand-plum-darkest)]">
            Chaarlie
          </span>
          <div className="flex items-center gap-2">
            <Link
              href="/kontakt"
              className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <CircleHelp className="size-4" />
              <span className="hidden sm:inline">Hilfe</span>
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <LogOut className="size-4" />
                <span className="hidden sm:inline">Abmelden</span>
              </button>
            </form>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-4 pb-10 pt-12 text-center sm:px-6 sm:pt-16">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-[var(--brand-plum)]/15 bg-[var(--brand-plum-ice)] px-3 py-1.5 text-xs font-bold text-[var(--brand-plum)]">
          <RotateCcw className="size-3.5" />
          Dein Chaarlie ist noch da
        </div>
        <h1 className="mx-auto mt-5 max-w-3xl font-[family-name:var(--font-display)] text-4xl font-medium leading-[1.04] tracking-[-0.035em] text-[var(--text-heading)] sm:text-6xl">
          Schön, dass du wieder da bist{firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Dein Haarprofil, deine Ziele und dein bisheriger Chaarlie-Kontext sind weiterhin
          gespeichert. Reaktiviere deine Mitgliedschaft und mach genau dort weiter, wo du aufgehört
          hast.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <div className="grid overflow-hidden rounded-[28px] border border-border/70 bg-white shadow-[0_30px_80px_-55px_rgba(var(--brand-plum-rgb),0.45)] lg:grid-cols-[1.05fr_0.95fr]">
          <div className="p-6 sm:p-9 lg:p-11">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--brand-coral)]">
              Wieder für dich da
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-medium leading-tight text-[var(--text-heading)] sm:text-4xl">
              Deine Haarpflege muss kein Ratespiel sein.
            </h2>
            <div className="mt-8 grid gap-6">
              {benefits.map((benefit) => {
                const Icon = benefit.icon
                return (
                  <div key={benefit.title} className="flex gap-4">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--brand-plum-ice)] text-[var(--brand-plum)]">
                      <Icon className="size-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-[var(--brand-plum-darkest)]">
                        {benefit.title}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {benefit.text}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="bg-[linear-gradient(145deg,var(--brand-plum-ice),#fff5ef)] p-6 sm:p-9 lg:p-11">
            <div className="mx-auto max-w-sm">
              <div className="rounded-[18px] border border-[var(--brand-plum)]/12 bg-white/80 p-4 shadow-[0_18px_55px_-42px_rgba(var(--brand-plum-rgb),0.55)]">
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--brand-coral)]">
                  Deine bisherige Routine
                </p>
                <h3 className="mt-2 text-lg font-bold leading-snug text-[var(--brand-plum-darkest)]">
                  Das ist die Routine, die wir bisher für dich erstellt haben.
                </h3>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                  Passt sie schon perfekt zu dir – oder möchtest du mit Chaarlie herausfinden, wie
                  sie noch besser zu deinen Haaren und deinem Alltag passt?
                </p>
              </div>
              <OfferPreviewRoutine preview={routinePreview} routineOnly />
            </div>
          </div>
        </div>
      </section>

      <section id="plaene" className="border-y border-border/60 bg-white py-16 sm:py-20">
        <div className="mx-auto grid max-w-6xl gap-9 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-start lg:gap-14">
          <div className="lg:sticky lg:top-8">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--brand-coral)]">
              Mitgliedschaft reaktivieren
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-medium leading-tight text-[var(--text-heading)] sm:text-4xl">
              Wähle den Rhythmus, der zu dir passt.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Alle Pläne schalten den gleichen vollständigen Chaarlie-Zugang frei. Du entscheidest
              nur, wie oft du bezahlen möchtest.
            </p>
            <div className="mt-7 grid gap-3 text-sm text-[var(--brand-plum-darkest)]">
              {[
                "Sofortiger Zugriff nach erfolgreicher Zahlung",
                "Jederzeit zum Laufzeitende kündbar",
                "Deine bisherigen Daten bleiben erhalten",
              ].map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                    <Check className="size-3.5" />
                  </span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-[#fbfaf8] p-4 shadow-[0_24px_65px_-48px_rgba(var(--brand-plum-rgb),0.5)] sm:p-6">
            {showCheckout ? (
              <MembershipReactivationCheckout
                initialInterval={initialInterval}
                returnDestination={returnDestination}
              />
            ) : (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm leading-relaxed text-amber-950">
                Wir können deinen Mitgliedschaftsstatus gerade nicht sicher prüfen. Bitte lade die
                Seite in einem Moment erneut. Bis dahin starten wir vorsichtshalber keine Zahlung.
              </div>
            )}

            <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border/70 pt-4 text-center text-[10px] font-semibold leading-tight text-muted-foreground">
              <span className="grid justify-items-center gap-1.5">
                <LockKeyhole className="size-4 text-[var(--brand-plum)]" /> Sichere Zahlung
              </span>
              <span className="grid justify-items-center gap-1.5">
                <ShieldCheck className="size-4 text-[var(--brand-plum)]" /> 14 Tage Garantie
              </span>
              <span className="grid justify-items-center gap-1.5">
                <RotateCcw className="size-4 text-[var(--brand-plum)]" /> Jederzeit kündbar
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="text-center">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--brand-coral)]">
            Noch Fragen?
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-medium text-[var(--text-heading)] sm:text-4xl">
            Das Wichtigste zur Reaktivierung
          </h2>
        </div>
        <div className="mt-8 grid gap-3">
          {faqs.map((faq) => (
            <details
              key={faq.question}
              className="group rounded-2xl border border-border/70 bg-white px-5 py-4 open:shadow-[0_14px_40px_-34px_rgba(var(--brand-plum-rgb),0.45)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold text-[var(--brand-plum-darkest)] marker:hidden">
                {faq.question}
                <ChevronDown className="size-4 shrink-0 text-[var(--brand-plum)] transition-transform group-open:rotate-180" />
              </summary>
              <p className="max-w-2xl pt-3 text-sm leading-relaxed text-muted-foreground">
                {faq.answer}
              </p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-border/60 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-7 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© Chaarlie · Dein persönlicher Haarpflege-Begleiter</span>
          <div className="flex gap-4">
            <span>Datenschutz</span>
            <span>AGB</span>
            <span>Impressum</span>
          </div>
        </div>
      </footer>
    </main>
  )
}
