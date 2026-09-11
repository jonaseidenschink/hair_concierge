"use client"

import type { KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from "react"

/**
 * Presentation-only wrapper for the example content inside `GatedPreview` (T12).
 *
 * The framed children are the REAL Routine / Anwendung / Chat components, which means
 * they are live DOM: the Anwendung day cards are `<Link>`s whose handler calls
 * `history.pushState`, the Routine cards carry `<details>` toggles, the chat input is a
 * real `<textarea>`. Inside the frame none of that may do anything — a tap anywhere
 * meaningful must be able to reach only the frame's one CTA (T11 carry-forward 3).
 *
 * How: one capture-phase handler per activation path. React dispatches capture listeners
 * root → target, so this runs BEFORE any handler on the element that was clicked;
 * `stopPropagation()` then cancels the rest of the dispatch (the target's own `onClick`
 * never runs) and `preventDefault()` cancels the browser default (link navigation,
 * `<details>` toggle, form submit). Keyboard activation funnels through the same `click`
 * event, so Enter on a link and Space on a button are covered by the same handler;
 * `auxclick` covers middle-click "open in new tab".
 *
 * Deliberately NOT the `inert` attribute: `inert` also removes the whole subtree from the
 * accessibility tree, which would leave a screen-reader user with an example page that
 * announces nothing but its „Beispiel" band. The example stays readable and focusable —
 * it just cannot *do* anything.
 */
function neutralize(event: SyntheticEvent) {
  event.preventDefault()
  event.stopPropagation()
}

/** Enter/Space are delivered as clicks too, but a stray key handler could still act. */
function neutralizeActivationKeys(event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") neutralize(event)
}

export function InertExample({
  children,
  className,
}: {
  children: ReactNode
  /**
   * Frame-fitting only. The real page bodies are written for a full viewport
   * (`min-h-dvh`, a bottom-nav-sized `padding-bottom`); inside the frame that would add
   * a screen of dead space to the in-frame scroll. Callers pass descendant-scoped
   * utilities to trim it — never anything that changes how a card itself looks.
   */
  className?: string
}) {
  return (
    <div
      data-gated-example-inert="true"
      className={className}
      onClickCapture={(event: MouseEvent) => neutralize(event)}
      onAuxClickCapture={(event: MouseEvent) => neutralize(event)}
      onSubmitCapture={neutralize}
      onKeyDownCapture={neutralizeActivationKeys}
    >
      {children}
    </div>
  )
}
