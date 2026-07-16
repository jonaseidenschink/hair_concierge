import Image from "next/image"
import { Star } from "lucide-react"

const APP_STORIES = [
  {
    trackingId: "product_story_routine",
    label: "Deine Routine",
    headline: "Deine Routine auf einen Blick.",
    body: "Produkte, Reihenfolge und Anwendung – klar an einem Ort.",
    image: "/images/funnels/app-value-stack/app-routine.png",
    imageAlt: "Chaarlie Routine mit Produkten und klarer Reihenfolge",
  },
  {
    trackingId: "product_story_chat",
    label: "Dein Haar-Berater",
    headline: "Frag Chaarlie zu deinem Haar.",
    body: "Chaarlie kennt dein Haarprofil und hilft dir, wenn etwas unklar ist oder sich verändert.",
    image: "/images/funnels/app-value-stack/app-chat.png",
    imageAlt: "Chaarlie Chat mit einer persönlichen Haarpflegefrage",
  },
  {
    trackingId: "product_story_products",
    label: "Deine Empfehlungen",
    headline: "Frag nach Produkten, die zu dir passen.",
    body: "Du bekommst Preis, Anwendung und eine verständliche Begründung direkt dazu.",
    image: "/images/funnels/app-value-stack/app-product-details.png",
    imageAlt: "Chaarlie Produktdetail mit Preis, Anwendung und Begründung",
  },
] as const

const TESTIMONIALS = [
  {
    source: "L. · Chaarlie-Kundin",
    quote:
      "Der Fragebogen ist echt gut und leicht verständlich. Im Chat hat das Antworten super geklappt. Auch die Produktempfehlung fand ich gut.",
  },
  {
    source: "A. · Chaarlie-Kundin",
    quote:
      "Ich finde die Interaktion sehr gut: meine Fragen stellen zu können und dann die benötigten Antworten zu bekommen.",
  },
  {
    source: "M. · Chaarlie-Kundin",
    quote:
      "Dass bei den Produkten der Preis und die Anwendung dabeistehen, ein Foto und warum er es empfiehlt. So muss ich nicht erst googeln.",
  },
] as const

function ScreenshotFrame({
  src,
  alt,
}: {
  src: (typeof APP_STORIES)[number]["image"]
  alt: (typeof APP_STORIES)[number]["imageAlt"]
}) {
  return (
    <div className="mx-auto w-full max-w-[292px] rounded-[34px] border-[7px] border-[var(--brand-plum-darkest)] bg-[var(--brand-plum-darkest)] p-[2px] shadow-[0_22px_60px_-34px_rgba(var(--brand-plum-rgb),0.75)]">
      <div className="relative aspect-[390/844] overflow-hidden rounded-[25px] bg-[#F3EFE8]">
        <Image
          alt={alt}
          className="object-cover object-top"
          fill
          sizes="(max-width: 640px) 76vw, 292px"
          src={src}
          unoptimized
        />
      </div>
    </div>
  )
}

function FiveStars() {
  return (
    <div aria-label="5 von 5 Sternen" className="flex justify-center gap-1" role="img">
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          aria-hidden="true"
          className="size-[17px] fill-[#E8A33D] text-[#E8A33D]"
          key={index}
        />
      ))}
    </div>
  )
}

export function AppValueStackProof() {
  return (
    <>
      <section className="border-t border-border py-10" data-testid="app-value-stack-proof">
        <div className="text-center">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-plum)]">
            Im Alltag mit Chaarlie
          </p>
          <h2 className="mx-auto mt-2 max-w-[13ch] font-header text-[32px] font-medium leading-[1.12] text-[var(--brand-plum-darkest)]">
            So begleitet dich Chaarlie.
          </h2>
          <p className="mx-auto mt-3 max-w-[38ch] text-[14px] leading-[1.6] text-muted-foreground">
            Von deiner Routine bis zur konkreten Produktfrage.
          </p>
        </div>

        <div className="mt-8 space-y-5">
          {APP_STORIES.map((story) => (
            <article
              key={story.label}
              data-offer-section={story.trackingId}
              className="space-y-5 rounded-[24px] border border-border bg-white px-5 py-7 text-center shadow-[0_16px_48px_-38px_rgba(var(--brand-plum-rgb),0.65)] sm:px-7"
            >
              <div className="mx-auto max-w-[42ch]">
                <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-plum)]">
                  {story.label}
                </p>
                <h3 className="mt-2 font-header text-[26px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
                  {story.headline}
                </h3>
                <p className="mt-2 text-[14px] leading-[1.6] text-muted-foreground">{story.body}</p>
              </div>
              <ScreenshotFrame alt={story.imageAlt} src={story.image} />
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-border py-10" data-testid="app-value-stack-testimonials">
        <div className="rounded-[28px] bg-[var(--brand-plum-ice)]/70 px-5 py-8 text-center sm:px-8 sm:py-10">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-plum)]">
            Echte Erfahrungen
          </p>
          <h2 className="mt-2 font-header text-[30px] font-medium leading-[1.15] text-[var(--brand-plum-darkest)]">
            Das sagen Chaarlie-Kundinnen.
          </h2>
          <p className="mx-auto mt-3 max-w-[40ch] text-[13px] leading-[1.6] text-muted-foreground">
            Entwickelt mit Erkenntnissen aus über 4.000 Antworten auf unsere Haarpflege-Umfrage.
          </p>

          <div className="mt-6 grid gap-4">
            {TESTIMONIALS.map((testimonial) => (
              <figure
                key={testimonial.source}
                className="rounded-[20px] border border-white/80 bg-white px-5 py-6 text-center shadow-[0_14px_36px_-30px_rgba(var(--brand-plum-rgb),0.7)] sm:px-7"
              >
                <FiveStars />
                <blockquote className="mt-4 font-header text-[16px] italic leading-[1.6] text-[var(--brand-plum-darkest)]">
                  “{testimonial.quote}”
                </blockquote>
                <figcaption className="mt-4 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--brand-plum)]">
                  {testimonial.source}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
