import { RoutinePage } from "@/components/routine/personal-plan/routine-page"
import { GATED_EXAMPLE_COPY } from "@/lib/gated-preview/example-copy"
import { GATED_ROUTINE_EXAMPLE_VIEW } from "@/lib/gated-preview/fixtures/routine-example"

import { GatedPreview } from "./gated-preview"
import { InertExample } from "./inert-example"

/**
 * The free tier's `/routine` (T12).
 *
 * `RoutinePage` — the exact component `PersonalPlanRoutineClient` renders once it has a
 * routine — is fed a static example view directly. Going one level below the client
 * wrapper is the point, not a shortcut: `PersonalPlanRoutineClient` fires
 * `POST /api/personal-plan/routine/sync` on mount and owns every other write on the
 * surface (proposal resolve, editor submit, product-detail read). None of that may run
 * from a page showing somebody else's example, and none of it is reachable here because
 * the module is never imported.
 *
 * The optional callbacks are all omitted, which is what makes the rendered cards inert
 * at the source rather than only at the wrapper: no `onEdit` means no „Anpassen" button,
 * no `onItemDetail` means the rows render as plain `<div>`s instead of buttons.
 */
export function GatedRoutineExample() {
  const copy = GATED_EXAMPLE_COPY.routine
  return (
    <GatedPreview
      feature={copy.feature}
      source={copy.source}
      exampleLabel={copy.exampleLabel}
      benefit={copy.benefit}
      cta={copy.cta}
    >
      <InertExample className="[&>div]:min-h-0 [&_main]:py-0 [&_main]:pb-2">
        <RoutinePage view={GATED_ROUTINE_EXAMPLE_VIEW} />
      </InertExample>
    </GatedPreview>
  )
}
