"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import Image from "next/image"
import { MessageCircle } from "lucide-react"

import { SiteFooter } from "@/components/landing/site-footer"
import type { PersonalPlanDiagnosticDimension } from "@/components/personal-plan-offer/types"
import type { ScannerOfferModel, ScannerOfferPlanId } from "./model"

/**
 * Scanner-Angebotsseite nach dem Quiz (Funnel-Modell "Scanner statt Angebotsseite").
 *
 * Reihenfolge der Seite ist Teil der Spezifikation und sollte nicht umsortiert werden:
 * 1. Haarprofil (Chips + drei Ausgangslage-Dimensionen)
 * 2. Brücke: was der Scanner mit den eigenen Produkten macht
 * 3. "So sieht der Scanner aus" (echter App-Screen)
 * 4. "So sieht die Auswertung aus" (Beispiel, klar als Beispiel markiert)
 * 5. Freischalten: 7 Tage kostenlos auf Monat und Jahr
 * 6. Was in der Testphase drin ist
 * 7. Stimmen aus der Beta (Textzitate; Videos folgen)
 * 8. FAQ
 * 9. Footer mit Rechtstexten
 * Dazu: Sticky-CTA (Mobile) und WhatsApp-Button.
 *
 * Bewusst NICHT enthalten: ein bewertetes Produkt aus dem Quiz. Das Quiz fragt keins ab,
 * und die Engine kann vor dem Account nichts bewerten.
 */

export type ScannerOfferProps = {
  model: ScannerOfferModel
  /**
   * Wird beim Klick auf "Scanner freischalten" aufgerufen. Der Checkout selbst
   * (Stripe mit trial_period_days, PayPal) wird vom Aufrufer geöffnet, analog zu
   * ResultOfferPricing. Im Lab ohne Handler zeigt der Button nur eine Bestätigung.
   */
  onUnlock?: (planId: ScannerOfferPlanId) => void
  /** wa.me-Link inkl. vorausgefülltem Text. Ohne Link wird kein Button gerendert. */
  whatsappHref?: string | null
  /** Optionaler Slot unter der Trial-Box, z. B. für Zahlungsarten-Hinweise. */
  belowPricing?: ReactNode
  isInternalTest?: boolean
}

const SPECTRUM_LABELS: Record<1 | 2 | 3, string> = {
  1: "Viel Potenzial",
  2: "Gute Basis",
  3: "Optimal",
}

const testimonials = [
  {
    name: "Kim · Endlich verstehe ich meine Haare",
    quote:
      "Der Fragebogen ist echt gut und leicht verständlich. Auch die Produktempfehlung fand ich gut.",
  },
  {
    name: "Kerstin · Echte Antworten bekommen",
    quote:
      "Ich finde die Interaktion sehr gut: meine Fragen stellen zu können und dann die benötigten Antworten zu bekommen.",
  },
  {
    name: "Sarah · Nie wieder googeln vorm Regal",
    quote:
      "Bei den Produkten stehen Preis, Anwendung und der Grund dabei, warum sie empfohlen werden.",
  },
] as const

const includedItems = [
  "Unbegrenzte Scans",
  "Drei Alternativen je Produkt",
  "Dein Haarplan mit Routine",
  "Haarcoach, rund um die Uhr",
  "Dein Produktregal, gespeichert",
] as const

const faqItems = [
  {
    id: "after-trial",
    question: "Was passiert nach den 7 Tagen?",
    answer:
      "Wenn du nicht kündigst, beginnt dein gewählter Tarif. Wir schicken dir an Tag 5 eine E-Mail, damit du das in Ruhe entscheiden kannst.",
  },
  {
    id: "cancel",
    question: "Wie kündige ich die Testphase?",
    answer:
      "In deinem Profil unter Abo mit einem Tipp, ohne Rückfrage. Bis Tag 7 kostet dich das nichts.",
  },
  {
    id: "drugstore",
    question: "Funktioniert das mit Drogerie-Produkten?",
    answer:
      "Ja. Über 1.000 Produkte von dm, Rossmann, Müller und aus dem Salon sind in der Datenbank, jede Woche kommen neue dazu.",
  },
  {
    id: "unknown-product",
    question: "Was, wenn ein Produkt nicht erkannt wird?",
    answer:
      "Dann fotografierst du die Rückseite, wir nehmen es innerhalb von 48 Stunden auf und du bekommst das Ergebnis per E-Mail.",
  },
  {
    id: "new-shampoo",
    question: "Warum reicht nicht einfach ein neues Shampoo?",
    answer:
      "Weil dein Haar drei Dinge braucht, die zusammenpassen: Reinigung, Pflege, Schutz. Der Scanner prüft jedes Produkt gegen dein Profil, nicht gegen die Verpackung.",
  },
] as const

const exampleAxes = [
  ["Pflegegewicht", "✓ passt", "ok"],
  ["Pflegerichtung", "✓ passt", "ok"],
  ["Repair-Unterstützung", "✕ zu niedrig", "no"],
  ["Geeignete Haardicke", "✕ für mittleres Haar", "no"],
] as const

function Segments({ count, tone }: { count: 1 | 2 | 3; tone: "today" | "goal" }) {
  return (
    <div className="flex gap-1.5" aria-label={`${count} von 3`}>
      {[1, 2, 3].map((segment) => (
        <span
          key={segment}
          className={
            segment <= count
              ? tone === "goal"
                ? "h-2.5 flex-1 rounded-full bg-[#3b8d60]"
                : "h-2.5 flex-1 rounded-full bg-[var(--brand-plum)]"
              : "h-2.5 flex-1 rounded-full bg-[rgba(var(--brand-plum-rgb),0.12)]"
          }
        />
      ))}
    </div>
  )
}

function DiagnosticRow({ row }: { row: PersonalPlanDiagnosticDimension }) {
  return (
    <article className="rounded-[1.25rem] border border-[rgba(var(--brand-plum-rgb),0.10)] bg-white p-4 shadow-[0_16px_44px_-36px_rgba(var(--brand-plum-rgb),0.55)]">
      <h3 className="font-serif text-[1.2rem] leading-tight text-[var(--brand-plum-darkest)]">
        {row.title}
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[rgba(var(--brand-plum-rgb),0.055)] p-3">
          <p className="mb-2 text-xs font-semibold leading-tight text-[rgba(var(--brand-plum-rgb),0.70)]">
            Heute · {SPECTRUM_LABELS[row.todaySegments]}
          </p>
          <Segments count={row.todaySegments} tone="today" />
        </div>
        <div className="rounded-xl bg-[var(--brand-plum-ice)] p-3">
          <p className="mb-2 text-xs font-semibold leading-tight text-[var(--brand-plum)]">
            Dein Ziel · {SPECTRUM_LABELS[row.potentialSegments]}
          </p>
          <Segments count={row.potentialSegments} tone="goal" />
        </div>
      </div>
      <p className="mt-3 text-[0.9rem] leading-6 text-[rgba(var(--brand-plum-rgb),0.75)]">
        {row.summary}
      </p>
    </article>
  )
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--brand-plum)]">
      {children}
    </p>
  )
}

function DeviceShot({ alt, src }: { alt: string; src: string }) {
  return (
    <div className="mx-auto mt-3 w-full max-w-[320px]">
      <Image
        alt={alt}
        className="block h-auto w-full drop-shadow-[0_18px_30px_rgba(42,24,69,0.22)]"
        height={1554}
        sizes="(max-width: 480px) 80vw, 320px"
        src={src}
        width={1206}
      />
    </div>
  )
}

function ShelfPhoto({ alt, src }: { alt: string; src: string }) {
  return (
    <div className="mt-3 overflow-hidden rounded-2xl">
      <Image
        alt={alt}
        className="block h-auto w-full"
        height={790}
        sizes="(max-width: 480px) 90vw, 440px"
        src={src}
        width={1254}
      />
    </div>
  )
}

function TrialTimeline({ afterTrialLabel }: { afterTrialLabel: string }) {
  const steps = [
    ["Heute: Scanner offen", "Alles freigeschaltet, sofort nach dem Klick."],
    ["Tag 5: Erinnerung", "Per E-Mail, mit einem Klick kündbar."],
    ["Tag 7: Abo beginnt", afterTrialLabel],
  ] as const
  return (
    <ol className="mt-4 grid grid-cols-[24px_1fr] gap-x-3">
      {steps.map(([title, detail], index) => (
        <li className="contents" key={title}>
          <span className="relative mt-[5px] ml-[5px] block h-3.5 w-3.5">
            <span
              className={`block h-3.5 w-3.5 rounded-full ${
                index === 0 ? "bg-[var(--brand-plum)]" : "bg-[var(--brand-plum-light)]"
              }`}
            />
            {index < steps.length - 1 ? (
              <span className="absolute left-[6px] top-3.5 h-10 w-0.5 bg-[rgba(var(--brand-plum-rgb),0.15)]" />
            ) : null}
          </span>
          <span className="block pb-3.5">
            <strong className="block text-[15px] text-[var(--brand-plum-darkest)]">{title}</strong>
            <span className="block text-[13px] text-[rgba(var(--brand-plum-rgb),0.62)]">
              {detail}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

export function ScannerOffer({
  belowPricing,
  isInternalTest,
  model,
  onUnlock,
  whatsappHref,
}: ScannerOfferProps) {
  const [planId, setPlanId] = useState<ScannerOfferPlanId>(model.defaultPlanId ?? model.plans[0].id)
  const [stickyVisible, setStickyVisible] = useState(false)
  const [labFeedback, setLabFeedback] = useState<string | null>(null)
  const trialRef = useRef<HTMLElement | null>(null)
  const selectedPlan = model.plans.find((plan) => plan.id === planId) ?? model.plans[0]

  useEffect(() => {
    const target = trialRef.current
    if (!target || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      ([entry]) => {
        setStickyVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0)
      },
      { threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  function scrollToTrial() {
    trialRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  function handleUnlock() {
    if (onUnlock) {
      onUnlock(planId)
      return
    }
    setLabFeedback(
      `Lab: Checkout für "${selectedPlan.title}" würde jetzt öffnen (${selectedPlan.detail}).`,
    )
  }

  return (
    <div
      className="min-h-screen bg-[#fdfbf9] pb-28 text-[var(--brand-plum-darkest)]"
      data-offer-variant="scanner-offer-v1"
    >
      {isInternalTest ? (
        <p className="bg-[var(--brand-plum-ice)] px-4 py-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-plum)]">
          Interner Test · Lab-Ansicht
        </p>
      ) : null}

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-[rgba(var(--brand-plum-rgb),0.10)] bg-[#fdfbf9]/95 px-5 py-3.5 backdrop-blur">
        <span className="font-serif text-2xl text-[var(--brand-plum-darkest)]">chaarlie</span>
        <button
          className="rounded-full bg-[var(--brand-plum)] px-3.5 py-2 text-[13px] font-semibold text-white"
          onClick={scrollToTrial}
          type="button"
        >
          Scanner freischalten
        </button>
      </header>

      <main className="mx-auto max-w-[480px]">
        {/* 1 · Haarprofil */}
        <section className="px-5 pt-7" data-offer-section="profile">
          <Eyebrow>{model.name ? `Dein Ergebnis, ${model.name}` : "Dein Ergebnis"}</Eyebrow>
          <h1 className="mt-2 font-serif text-[34px] leading-[1.1] tracking-[-0.01em] text-[var(--brand-plum-darkest)]">
            {model.profileHeadline}
          </h1>
          <p className="mt-2.5 text-[15px] text-[rgba(var(--brand-plum-rgb),0.75)]">
            Aus deinen Antworten haben wir dein Haarprofil erstellt. So ordnen wir dein Haar ein.
          </p>
          {model.profileChips.length ? (
            <ul className="mt-3.5 flex flex-wrap gap-2">
              {model.profileChips.map((chip) => (
                <li
                  className="rounded-full border border-[rgba(var(--brand-plum-rgb),0.12)] bg-white px-3 py-1.5 text-[13px] font-semibold"
                  key={`${chip.label}-${chip.value}`}
                >
                  <span className="mr-1 font-normal text-[rgba(var(--brand-plum-rgb),0.55)]">
                    {chip.label}
                  </span>
                  {chip.value}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="px-5 pt-5" data-offer-section="diagnostic">
          <Eyebrow>Deine Ausgangslage</Eyebrow>
          <div className="mt-3 grid gap-3">
            {model.diagnosticRows.map((row) => (
              <DiagnosticRow key={row.id} row={row} />
            ))}
          </div>
          <div className="mt-3.5 rounded-[14px] bg-[#e6f2ea] px-4 py-3.5">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#3c7d5a]">
              Das Gute
            </p>
            <p className="mt-0.5 font-serif text-[20px] text-[var(--brand-plum-darkest)]">
              Hier können wir gezielt ansetzen.
            </p>
            <p className="mt-1 text-[14px] text-[rgba(var(--brand-plum-rgb),0.75)]">
              {model.encouragement}
            </p>
          </div>
        </section>

        {/* 2 · Brücke */}
        <section className="px-5 pt-7" data-offer-section="bridge">
          <div className="rounded-[20px] bg-[var(--brand-plum-darkest)] px-5 py-6 text-white">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--brand-plum-light)]">
              Das ist für deine Produkte
            </p>
            <h2 className="mt-2 font-serif text-[26px] leading-[1.1] tracking-[-0.01em]">
              Der Scanner zeigt dir, ob deine Produkte zu Hause oder in der Drogerie zu deinen
              Haaren passen.
            </h2>
            <p className="mt-2.5 text-[15px] text-white/80">
              Handy dranhalten, eine Sekunde: passt oder passt nicht. Mit dem Grund. Und zu jedem,
              was nicht passt, drei Alternativen.
            </p>
          </div>
        </section>

        {/* 3 · So sieht der Scanner aus */}
        <section className="px-5 pt-3.5" data-offer-section="scanner-demo">
          <div className="rounded-[20px] border border-[rgba(var(--brand-plum-rgb),0.10)] bg-white p-3.5">
            <div className="flex items-center justify-between">
              <strong className="text-[15px]">So sieht der Scanner aus</strong>
              <span className="rounded-full bg-[var(--brand-plum-ice)] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
                Schritt 1
              </span>
            </div>
            <ShelfPhoto
              alt="Hand hält das Handy im Drogerie-Regal, der Chaarlie-Scanner erkennt ein Balea-Shampoo"
              src="/images/funnels/scanner-offer/photo-scanner-shelf.webp"
            />
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                ["1", "Handy an das Produkt halten"],
                ["1 s", "bis das Ergebnis da ist"],
                ["3", "Alternativen, wenn es nicht passt"],
              ].map(([figure, caption]) => (
                <div
                  className="rounded-xl border border-[rgba(var(--brand-plum-rgb),0.10)] bg-[#fdfbf9] px-2 py-2.5 text-center text-[12px] leading-[1.35] text-[rgba(var(--brand-plum-rgb),0.75)]"
                  key={caption}
                >
                  <span className="mb-0.5 block font-serif text-[20px] text-[var(--brand-plum-darkest)]">
                    {figure}
                  </span>
                  {caption}
                </div>
              ))}
            </div>
          </div>

          {/* 4 · So sieht die Auswertung aus */}
          <div className="mt-3.5 rounded-[20px] border border-[rgba(var(--brand-plum-rgb),0.10)] bg-white p-3.5">
            <div className="flex items-center justify-between">
              <strong className="text-[15px]">So sieht die Auswertung aus</strong>
              <span className="rounded-full bg-[var(--brand-plum-ice)] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
                Beispiel
              </span>
            </div>
            <DeviceShot
              alt="Beispiel-Auswertung: Conditioner, Passt nicht zu deinem Haar, 2 von 4 Zielbereichen, vier Achsen mit Häkchen und Kreuzen"
              src="/images/funnels/scanner-offer/device-scan-example.webp"
            />
            <ul className="mt-3 grid gap-1.5">
              {exampleAxes.map(([axis, verdict, tone]) => (
                <li
                  className="flex justify-between rounded-[10px] bg-[#fdfbf9] px-2.5 py-2 text-[13px]"
                  key={axis}
                >
                  <span className="font-semibold">{axis}</span>
                  <span
                    className={
                      tone === "ok"
                        ? "font-semibold text-[#3c7d5a]"
                        : "font-semibold text-[#9b2c3b]"
                    }
                  >
                    {verdict}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[13px] text-[rgba(var(--brand-plum-rgb),0.75)]">
              Beispiel für ein feines, geschädigtes Haarprofil. Kein schlechtes Produkt, nur für ein
              anderes Haar gebaut. Genau das siehst du bei jedem Produkt in deinem Bad.
            </p>
          </div>
        </section>

        {/* 5 · Freischalten */}
        <section
          className="scroll-mt-16 px-5 pt-7"
          data-offer-section="pricing"
          id="pricing"
          ref={trialRef}
          tabIndex={-1}
        >
          <Eyebrow>Jetzt freischalten</Eyebrow>
          <h2 className="mt-2 font-serif text-[26px] leading-[1.1] tracking-[-0.01em]">
            Schalte den Scanner frei. 7 Tage kostenlos.
          </h2>
          <div className="relative mt-4 rounded-[20px] border-2 border-[var(--brand-plum)] bg-white px-4.5 pb-4 pt-5">
            <span className="absolute -top-3 left-4 rounded-full bg-[var(--brand-plum)] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-white">
              Einmalig für dein Profil
            </span>
            <p className="text-[15px] text-[rgba(var(--brand-plum-rgb),0.75)]">
              Unbegrenzte Scans, die drei Alternativen zu jedem Produkt, dein Haarplan und der
              Haarcoach. Wir erinnern dich an Tag 5, bevor etwas berechnet wird.
            </p>
            <TrialTimeline afterTrialLabel={selectedPlan.afterTrialLabel} />

            <fieldset className="mt-1 grid gap-2.5">
              <legend className="sr-only">Tarif</legend>
              {model.plans.map((plan) => {
                const selected = plan.id === planId
                return (
                  <label
                    className={`relative flex cursor-pointer items-center gap-3 rounded-[14px] border-[1.5px] px-3.5 py-3 ${
                      selected
                        ? "border-[var(--brand-plum)] bg-[#f6f3fb]"
                        : "border-[rgba(var(--brand-plum-rgb),0.14)] bg-white"
                    }`}
                    key={plan.id}
                  >
                    {plan.badge ? (
                      <span className="absolute -top-2 right-3 rounded-full bg-[var(--brand-coral)] px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-white">
                        {plan.badge}
                      </span>
                    ) : null}
                    <input
                      checked={selected}
                      className="sr-only"
                      name="scanner-offer-plan"
                      onChange={() => setPlanId(plan.id)}
                      type="radio"
                      value={plan.id}
                    />
                    <span
                      aria-hidden="true"
                      className={`h-[18px] w-[18px] flex-none rounded-full ${
                        selected
                          ? "border-[6px] border-[var(--brand-plum)]"
                          : "border-[1.5px] border-[var(--brand-plum-light)]"
                      }`}
                    />
                    <span className="flex-1">
                      <strong className="block text-[15px]">{plan.title}</strong>
                      <span className="block text-[12.5px] text-[rgba(var(--brand-plum-rgb),0.62)]">
                        {plan.detail}
                      </span>
                    </span>
                    <span className="text-right text-[14px] font-semibold tabular-nums">
                      {plan.priceLabel}
                      {plan.priceNote ? (
                        <span className="block text-[11px] font-semibold text-[#3c7d5a]">
                          {plan.priceNote}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </fieldset>

            <button
              className="mt-3.5 block w-full rounded-[14px] bg-[var(--brand-coral)] px-4 py-4 text-center text-[16px] font-bold text-white"
              onClick={handleUnlock}
              type="button"
            >
              Scanner freischalten, 7 Tage kostenlos
            </button>
            <p className="mt-2.5 text-center text-[11.5px] leading-[1.45] text-[rgba(var(--brand-plum-rgb),0.62)]">
              Danach {selectedPlan.afterTrialLabel} Kündbar bis Tag 7 ohne Kosten. Es gilt das
              14-tägige Widerrufsrecht.
            </p>
            <p className="mt-2.5 flex flex-wrap justify-center gap-3.5 text-[11.5px] text-[rgba(var(--brand-plum-rgb),0.75)]">
              <span>✓ PayPal · Apple Pay · Karte</span>
              <span>✓ Mit Friseurmeistern entwickelt</span>
            </p>
            {labFeedback ? (
              <p
                className="mt-3 rounded-xl bg-[var(--brand-plum-ice)] px-3 py-2 text-center text-[12.5px] text-[var(--brand-plum)]"
                role="status"
              >
                {labFeedback}
              </p>
            ) : null}
          </div>
          {belowPricing}
        </section>

        {/* 6 · Was drin ist */}
        <section className="px-5 pt-7" data-offer-section="included">
          <Eyebrow>Was in der Testphase drin ist</Eyebrow>
          <ul className="mt-3 rounded-[18px] border border-[rgba(var(--brand-plum-rgb),0.10)] bg-white px-4">
            {includedItems.map((item) => (
              <li
                className="flex items-center justify-between border-b border-[rgba(var(--brand-plum-rgb),0.08)] py-3 text-[15px] last:border-b-0"
                key={item}
              >
                <strong>{item}</strong>
                <span className="rounded-full bg-[#e6f2ea] px-2.5 py-0.5 text-[11px] font-bold text-[#3c7d5a]">
                  frei
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* 7 · Stimmen */}
        <section className="px-5 pt-7" data-offer-section="testimonials">
          <Eyebrow>Stimmen aus der Beta</Eyebrow>
          <h2 className="mt-2 font-serif text-[26px] leading-[1.1] tracking-[-0.01em]">
            Das sagen Kundinnen über Chaarlie.
          </h2>
          <div className="mt-3 grid gap-3">
            {testimonials.map((testimonial) => (
              <blockquote
                className="rounded-[18px] border border-[rgba(var(--brand-plum-rgb),0.10)] bg-white p-4"
                key={testimonial.name}
              >
                <span
                  aria-label="5 von 5 Sternen"
                  className="text-[14px] tracking-[1px] text-[#d96869]"
                >
                  ★★★★★
                </span>
                <strong className="mt-1.5 block text-[15px]">{testimonial.name}</strong>
                <p className="mt-1.5 text-[14.5px] leading-6 text-[rgba(var(--brand-plum-rgb),0.75)]">
                  „{testimonial.quote}“
                </p>
              </blockquote>
            ))}
          </div>
          <p className="mt-3.5 border-l-2 border-[var(--brand-plum-light)] pl-3 text-[14px] text-[rgba(var(--brand-plum-rgb),0.75)]">
            <strong className="block text-[13px] text-[var(--brand-plum-darkest)]">
              Über 4.000 Frauen haben uns geantwortet
            </strong>
            82 % wollen verstehen, was ihr Haar wirklich braucht. 63 % suchen Klarheit, welche
            Produkte wirklich passen.
          </p>
        </section>

        {/* 8 · FAQ */}
        <section className="px-5 pt-7" data-offer-section="faq">
          <Eyebrow>Häufige Fragen</Eyebrow>
          <div className="mt-2.5">
            {faqItems.map((item) => (
              <details
                className="group border-t border-[rgba(var(--brand-plum-rgb),0.10)] py-3 last:border-b"
                key={item.id}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <span
                    aria-hidden="true"
                    className="ml-3 text-[18px] text-[rgba(var(--brand-plum-rgb),0.55)] transition-transform group-open:rotate-180"
                  >
                    ⌄
                  </span>
                </summary>
                <p className="mt-2 text-[14px] leading-6 text-[rgba(var(--brand-plum-rgb),0.75)]">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>
      </main>

      {/* 9 · Footer mit Impressum, Datenschutz, AGB, Widerruf, Kontakt */}
      <SiteFooter />

      {whatsappHref ? (
        <a
          aria-label="Frage per WhatsApp stellen"
          className={`fixed right-[18px] z-30 grid h-[54px] w-[54px] place-items-center rounded-full bg-[#25d366] text-white shadow-[0_10px_24px_rgba(0,0,0,0.2)] transition-[bottom] ${
            stickyVisible ? "bottom-[92px]" : "bottom-6"
          } sm:right-[calc(50%-240px+18px)]`}
          href={whatsappHref}
          rel="noopener noreferrer"
          target="_blank"
        >
          <MessageCircle className="h-7 w-7" strokeWidth={2.25} />
        </a>
      ) : null}

      <div
        aria-hidden={!stickyVisible}
        className={`fixed inset-x-0 bottom-0 z-20 border-t border-[rgba(var(--brand-plum-rgb),0.10)] bg-[#fdfbf9]/95 px-5 pb-4 pt-2.5 backdrop-blur transition-transform sm:hidden ${
          stickyVisible ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto flex max-w-[480px] items-center gap-3">
          <small className="w-[100px] text-[11px] leading-[1.3] text-[rgba(var(--brand-plum-rgb),0.62)]">
            7 Tage kostenlos, dann {selectedPlan.afterTrialLabel.replace(/\.$/, "")}
          </small>
          <button
            className="flex-1 rounded-[14px] bg-[var(--brand-coral)] px-4 py-3.5 text-[15px] font-bold text-white"
            onClick={scrollToTrial}
            tabIndex={stickyVisible ? 0 : -1}
            type="button"
          >
            Scanner freischalten
          </button>
        </div>
      </div>
    </div>
  )
}
