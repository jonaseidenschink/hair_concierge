const FAQS = [
  {
    id: "after_payment",
    question: "Was passiert direkt nach der Zahlung?",
    answer:
      "Du aktivierst deinen Zugang und ergänzt deine aktuellen Produkte und Gewohnheiten. Chaarlie finalisiert daraus deine konkrete Routine, Reihenfolge und Anwendung.",
  },
  {
    id: "example_products",
    question: "Sind die Produkte auf dieser Seite schon meine finalen Empfehlungen?",
    answer:
      "Nein. Sie sind nachvollziehbare Beispiele aus deinen Quiz-Angaben. Nach dem Start gleicht Chaarlie sie mit deinen vorhandenen Produkten und weiteren Pflegedetails ab.",
  },
  {
    id: "not_just_chatbot",
    question: "Ist Chaarlie nur ein Chatbot?",
    answer:
      "Nein. Chat, Haarprofil, Produktroutine und Produktdaten arbeiten zusammen. Deine Routine bleibt separat sichtbar und kann weiterentwickelt werden.",
  },
  {
    id: "ongoing_access",
    question: "Warum brauche ich laufenden Zugang?",
    answer:
      "Weil neue Produkte, Jahreszeiten, Styling und Veränderungen neue Fragen erzeugen. Chaarlie bleibt dein geduldiger Haarpflege-Begleiter statt einer einmaligen PDF-Auswertung.",
  },
  {
    id: "independent_products",
    question: "Verkauft Chaarlie eigene Produkte?",
    answer:
      "Nein. Chaarlie führt keine eigene Produktlinie. Empfehlungen werden aus deinem Profil und erfassten Produktdaten abgeleitet.",
  },
  {
    id: "cancellation",
    question: "Kann ich kündigen?",
    answer:
      "Ja. Du kannst zum Ende der gewählten Laufzeit kündigen; die monatliche Variante ist monatlich kündbar.",
  },
] as const

export function OfferFaq() {
  return (
    <section data-offer-section="faq" className="border-t border-border py-9">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--brand-plum)]">
        Häufige Fragen
      </p>
      <h2 className="mt-2 font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
        Was du wissen solltest.
      </h2>
      <div className="mt-5 divide-y divide-border rounded-[18px] border border-border bg-white px-5">
        {FAQS.map(({ id, question, answer }) => (
          <details key={id} data-offer-faq={id} className="group py-4 first:pt-5 last:pb-5">
            <summary className="cursor-pointer list-none pr-7 text-[14px] font-bold leading-snug text-[var(--brand-plum-darkest)] marker:hidden">
              {question}
            </summary>
            <p className="mt-3 text-[12.5px] leading-[1.65] text-muted-foreground">{answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
