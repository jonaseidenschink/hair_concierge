import { ApplicationPage } from "@/components/application/application-page"
import { GATED_EXAMPLE_COPY } from "@/lib/gated-preview/example-copy"
import { GATED_ANWENDUNG_EXAMPLE_VIEW } from "@/lib/gated-preview/fixtures/anwendung-example"

import { GatedPreview } from "./gated-preview"
import { InertExample } from "./inert-example"

/**
 * The free tier's `/anwendung` (T12).
 *
 * Direct view injection into the REAL `ApplicationPage` — the same pattern
 * `/labs/personal-plan-application` uses, one level below `RouteAwareApplicationPage`:
 * without `currentPathname` the page never calls `usePathname`, so it renders its
 * overview from the injected view and nothing else. Day navigation is neutralised by
 * `InertExample` (the day cards are `<Link>`s whose click handler would `pushState`).
 *
 * The example is deliberately populated — real products on the shelves, not a row of
 * empty silhouettes (Nick, explicit). The one empty day is the Pausentag, which is empty
 * by design.
 */
export function GatedAnwendungExample() {
  const copy = GATED_EXAMPLE_COPY.anwendung
  return (
    <GatedPreview
      feature={copy.feature}
      source={copy.source}
      exampleLabel={copy.exampleLabel}
      benefit={copy.benefit}
      cta={copy.cta}
    >
      <InertExample className="[&>div]:min-h-0 [&_section]:px-0 [&_section]:py-0">
        <ApplicationPage view={GATED_ANWENDUNG_EXAMPLE_VIEW} />
      </InertExample>
    </GatedPreview>
  )
}
