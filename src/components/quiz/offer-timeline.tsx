const STEPS = [
  [
    "Direkt",
    "Deine Routine wird vollständig",
    "Du ergänzt Produkte und Gewohnheiten; Chaarlie ordnet sie ein und schließt die wichtigsten Lücken.",
  ],
  [
    "Danach",
    "Produkte und Anwendung werden konkret",
    "Du siehst, was du benutzt, warum es passt und wie du jeden Schritt anwendest.",
  ],
  [
    "Laufend",
    "Dein Haarbegleiter bleibt verfügbar",
    "Du kannst neue Produkte prüfen, Rückfragen stellen und den Plan an Veränderungen anpassen.",
  ],
] as const

export function OfferTimeline() {
  return (
    <section data-offer-section="subscription_explanation" className="border-t border-border py-9">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--brand-plum)]">
        Ab jetzt an deiner Seite
      </p>
      <h2 className="mt-2 font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
        Warum Chaarlie ein Abo ist.
      </h2>
      <div className="mt-6 space-y-0">
        {STEPS.map(([label, title, body], index) => (
          <div key={label} className="relative flex gap-4 pb-6 last:pb-0">
            {index < STEPS.length - 1 ? (
              <span className="absolute bottom-0 left-[25px] top-[46px] w-px bg-[var(--brand-plum-light)]" />
            ) : null}
            <span className="z-10 grid size-[52px] shrink-0 place-items-center rounded-full border border-[var(--brand-plum-light)] bg-white font-mono text-[8px] font-semibold uppercase tracking-[0.05em] text-[var(--brand-plum)]">
              {label}
            </span>
            <div className="pt-1">
              <h3 className="text-[15px] font-bold text-[var(--brand-plum-darkest)]">{title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
