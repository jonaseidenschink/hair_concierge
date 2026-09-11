import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { GatedAnwendungExample } from "../src/components/gated-preview/gated-anwendung-example"
import { GatedChatExample } from "../src/components/gated-preview/gated-chat-example"
import { GatedRoutineExample } from "../src/components/gated-preview/gated-routine-example"
import { InertExample } from "../src/components/gated-preview/inert-example"

/**
 * The T12 zero-mutation lane: a gated Routine / Anwendung / Chat render must perform NO
 * network work at all — not a mutation, not even a read — and must offer no way out of
 * the frame.
 *
 * Three complementary proofs, because no single one is sufficient:
 *
 * 1. **Render trap** — every network primitive is replaced by a recorder before the three
 *    compositions are rendered. Catches anything that fetches while rendering.
 * 2. **Module trap** — the composition modules are asserted not to (transitively) reach
 *    the components that own the writes. This is the one that would catch the regression
 *    that matters: somebody swapping `RoutinePage` back for `PersonalPlanRoutineClient`
 *    (whose mount effect POSTs `/api/personal-plan/routine/sync`) or `ChatMessage` for
 *    `ChatContainer` (`useChat`). A render trap cannot see it, because SSR never runs
 *    mount effects.
 * 3. **Escape trap** — every link the real components render sits inside the one inert
 *    wrapper, and the wrapper genuinely cancels activation.
 */

// --- 1. render trap ---------------------------------------------------------

type NetworkCall = { api: string; detail: string }

function withNetworkTrapped<T>(body: () => T): { result: T; calls: NetworkCall[] } {
  const calls: NetworkCall[] = []
  const globals = globalThis as Record<string, unknown>
  const originalDescriptors = ["fetch", "XMLHttpRequest", "navigator"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )

  // `navigator` is a getter-only own property of `globalThis` in modern Node, so every
  // trap is installed by descriptor rather than assignment.
  const install = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

  install("fetch", (input: unknown, init?: { method?: string }) => {
    calls.push({ api: "fetch", detail: `${init?.method ?? "GET"} ${String(input)}` })
    return Promise.reject(new Error("network is trapped"))
  })
  install(
    "XMLHttpRequest",
    class {
      open(method: string, url: string) {
        calls.push({ api: "XMLHttpRequest", detail: `${method} ${url}` })
      }
      send() {}
      setRequestHeader() {}
      addEventListener() {}
    },
  )
  install("navigator", {
    ...(globals.navigator as object | undefined),
    sendBeacon: (url: string) => {
      calls.push({ api: "sendBeacon", detail: url })
      return true
    },
  })

  try {
    return { result: body(), calls }
  } finally {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globals[key]
    }
  }
}

const COMPOSITIONS = [
  ["routine", GatedRoutineExample],
  ["anwendung", GatedAnwendungExample],
  ["chat", GatedChatExample],
] as const

function renderComposition(Composition: () => React.ReactElement) {
  return withNetworkTrapped(() => renderToStaticMarkup(<Composition />))
}

for (const [name, Composition] of COMPOSITIONS) {
  test(`gated ${name} renders without touching the network`, () => {
    const { result, calls } = renderComposition(Composition)
    assert.deepEqual(
      calls,
      [],
      `gated ${name} must issue zero requests, got ${JSON.stringify(calls)}`,
    )
    assert.ok(result.length > 0, "the composition renders something")
  })

  test(`gated ${name} renders no form and no submit control`, () => {
    const { result } = renderComposition(Composition)
    // A mutation needs a transport: fetch (trapped above) or a form. Neither exists.
    assert.doesNotMatch(result, /<form/i)
    assert.doesNotMatch(result, /type="submit"/i)
    assert.doesNotMatch(result, /formaction=/i)
  })
}

// --- 2. module trap ---------------------------------------------------------

const SOURCE_ROOT = path.resolve(process.cwd(), "src")

/** Resolves the repo's `@/…` alias plus relative imports, .ts/.tsx/index only. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(SOURCE_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null
  if (!base) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8")
      return candidate
    } catch {
      // keep trying
    }
  }
  return null
}

function importGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    const source = readFileSync(file, "utf8")
    seen.set(file, source)
    // `import type … from "x"` / `export type … from "x"` are erased by the compiler and
    // never reach the runtime — a type-only reference to `use-chat`'s param shapes (which
    // `chat-message.tsx` has) is not a runtime edge and must not count as one.
    for (const match of source.matchAll(
      /\b(?:import|export)\s+(type\s+)?[^;"']*?from\s+"([^"]+)"/g,
    )) {
      if (match[1]) continue
      const resolved = resolveModule(file, match[2])
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

const COMPOSITION_ENTRIES = {
  routine: path.join(SOURCE_ROOT, "components/gated-preview/gated-routine-example.tsx"),
  anwendung: path.join(SOURCE_ROOT, "components/gated-preview/gated-anwendung-example.tsx"),
  chat: path.join(SOURCE_ROOT, "components/gated-preview/gated-chat-example.tsx"),
}

/** Every module that owns a write on one of the three gated surfaces. */
const WRITE_OWNING_MODULES = [
  "components/routine/personal-plan/personal-plan-routine-client.tsx",
  "components/routine/personal-plan/routine-editor.tsx",
  "components/routine/personal-plan/routine-proposal-sheet.tsx",
  "components/routine/personal-plan/routine-attention-indicator.tsx",
  "components/chat/chat-container.tsx",
  "components/chat/conversation-sidebar.tsx",
  "hooks/use-chat.ts",
]

/**
 * Positive control: without this the module trap could pass simply because the graph
 * walker resolves nothing. These are real components the compositions must reach.
 */
test("the import-graph walker actually reaches the real page components", () => {
  const reached = (entry: string) =>
    [...importGraph(entry).keys()].map((file) => path.relative(SOURCE_ROOT, file))

  assert.ok(
    reached(COMPOSITION_ENTRIES.routine).includes(
      "components/routine/personal-plan/routine-item-card.tsx",
    ),
    "the Routine example renders through the real routine cards",
  )
  assert.ok(
    reached(COMPOSITION_ENTRIES.anwendung).includes(
      "components/application/application-day-card.tsx",
    ),
    "the Anwendung example renders through the real day cards",
  )
  assert.ok(
    reached(COMPOSITION_ENTRIES.chat).includes("components/chat/chat-message.tsx"),
    "the Chat example renders through the real chat bubbles",
  )
})

for (const [name, entry] of Object.entries(COMPOSITION_ENTRIES)) {
  test(`gated ${name} never reaches a module that writes`, () => {
    const graph = importGraph(entry)
    const reached = [...graph.keys()].map((file) => path.relative(SOURCE_ROOT, file))
    for (const writeOwner of WRITE_OWNING_MODULES) {
      assert.ok(
        !reached.includes(writeOwner),
        `gated ${name} must not import ${writeOwner} — it owns live writes`,
      )
    }
  })

  test(`gated ${name} contains no request call of its own`, () => {
    const graph = importGraph(entry)
    // Only the composition + its own fixture/copy modules are checked: the shared UI
    // components below them are covered by the module trap above (none of the reachable
    // ones fetch) and by the render trap.
    for (const [file, source] of graph) {
      const relative = path.relative(SOURCE_ROOT, file)
      if (
        !relative.startsWith("components/gated-preview/") &&
        !relative.startsWith("lib/gated-preview/")
      ) {
        continue
      }
      assert.doesNotMatch(source, /\bfetch\s*\(/, `${relative} must not call fetch`)
      assert.doesNotMatch(source, /sendBeacon/, `${relative} must not beacon`)
      assert.doesNotMatch(source, /"\/api\//, `${relative} must not name an API route`)
    }
  })
}

// --- 3. escape trap ---------------------------------------------------------

for (const [name, Composition] of COMPOSITIONS) {
  test(`gated ${name}: every example link sits inside the inert wrapper`, () => {
    const { result } = renderComposition(Composition)
    const inertStart = result.indexOf('data-gated-example-inert="true"')
    assert.ok(inertStart > -1, "the example is wrapped in InertExample")
    const inertEnd = result.indexOf("data-gated-preview-cta-block", inertStart)
    assert.ok(inertEnd > inertStart, "the CTA block closes the frame after the example")

    // No anchor may exist outside the inert region (the CTA itself is a <button>).
    const outside = result.slice(0, inertStart) + result.slice(inertEnd)
    assert.doesNotMatch(outside, /<a\s/i, `gated ${name} must expose no link beside the CTA`)
  })
}

test("InertExample cancels activation before the wrapped component's own handler runs", () => {
  const element = InertExample({ children: null }) as React.ReactElement<Record<string, any>>
  assert.equal(element.props["data-gated-example-inert"], "true")

  for (const handler of ["onClickCapture", "onAuxClickCapture", "onSubmitCapture"]) {
    let prevented = false
    let stopped = false
    element.props[handler]({
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {
        stopped = true
      },
    })
    assert.ok(prevented, `${handler} prevents the browser default (navigation, submit, toggle)`)
    assert.ok(stopped, `${handler} stops the dispatch before the target's own handler`)
  }
})

test("InertExample also cancels keyboard activation", () => {
  const element = InertExample({ children: null }) as React.ReactElement<Record<string, any>>
  const seen: string[] = []
  const event = (key: string) => ({
    key,
    preventDefault: () => seen.push(`prevented:${key}`),
    stopPropagation: () => seen.push(`stopped:${key}`),
  })

  element.props.onKeyDownCapture(event("Enter"))
  element.props.onKeyDownCapture(event(" "))
  element.props.onKeyDownCapture(event("Tab"))

  assert.deepEqual(seen, ["prevented:Enter", "stopped:Enter", "prevented: ", "stopped: "])
  // Tab is untouched: a keyboard user must still be able to reach the CTA.
})
