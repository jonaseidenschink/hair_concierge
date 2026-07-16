const PRODUCT_STORY = [
  {
    trackingId: "product_story_chat",
    image: "/images/offer/advisor.jpg",
    alt: "Chaarlie Chat mit persönlichem Haarkontext",
    kicker: "Fragen klären",
    title: "Antworten, wenn die nächste Frage kommt.",
    body: "Ist dieses Produkt passend? Wie viel soll ich nehmen? Was ändere ich bei Frizz? Chaarlie kennt Profil und Routine und antwortet auf deinen Fall.",
  },
  {
    trackingId: "product_story_routine",
    image: "/images/offer/routine.jpg",
    alt: "Chaarlie Routine mit konkreten Schritten",
    kicker: "Routine aufbauen",
    title: "Was, wann und in welcher Reihenfolge.",
    body: "Dein vollständiger Plan verbindet Produktnamen, Rhythmus und Anwendung – und beginnt mit dem, was du schon besitzt.",
  },
  {
    trackingId: "product_story_products",
    image: "/images/offer/products.jpg",
    alt: "Chaarlie Produktauswahl in einer Drogerie",
    kicker: "Produkte prüfen",
    title: "Weniger Rätselraten vor dem Kauf.",
    body: "Chaarlie erklärt, warum ein Produkt zu deinem Profil passen kann, und hilft dir, Alternativen einzuordnen.",
  },
] as const

export function OfferProductStory() {
  return (
    <section className="border-t border-border py-9">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--brand-plum)]">
        Chaarlie in Aktion
      </p>
      <h2 className="mt-2 font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
        Das kaufst du – nicht nur ein Quiz-Ergebnis.
      </h2>
      <div className="mt-6 space-y-4">
        {PRODUCT_STORY.map((item, index) => (
          <article
            key={item.title}
            data-offer-section={item.trackingId}
            className="overflow-hidden rounded-[18px] border border-border bg-white"
          >
            <div className="h-[220px] overflow-hidden bg-[var(--brand-plum-ice)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- local marketing screenshots render reliably in static tests. */}
              <img
                className="h-full w-full object-cover"
                src={item.image}
                alt={item.alt}
                loading="lazy"
              />
            </div>
            <div className="p-5">
              <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
                {index + 1}. {item.kicker}
              </p>
              <h3 className="mt-2 text-[18px] font-bold leading-snug text-[var(--brand-plum-darkest)]">
                {item.title}
              </h3>
              <p className="mt-2 text-[13px] leading-[1.6] text-muted-foreground">{item.body}</p>
            </div>
          </article>
        ))}
      </div>
      <div className="mt-5 rounded-[16px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] p-5 text-center">
        <strong className="font-header text-[30px] font-medium text-[var(--brand-plum-darkest)]">
          500+
        </strong>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          erfasste Produkte aus Drogerie und Salon. Chaarlie verkauft keine eigene Produktlinie.
        </p>
      </div>
    </section>
  )
}
