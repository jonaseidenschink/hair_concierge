import assert from "node:assert/strict"
import test from "node:test"

import { observeOnceEngaged } from "../src/lib/analytics/observe-once-engaged"

type VisibilityListener = () => void

function createHarness() {
  const element = {} as Element
  let observerCallback: IntersectionObserverCallback | undefined
  let scheduled: (() => void) | undefined
  let disconnected = 0
  let cleared = 0
  let tracked = 0
  const listeners = new Set<VisibilityListener>()
  const documentTarget = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as VisibilityListener)
    },
    removeEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as VisibilityListener)
    },
  }

  class FakeObserver {
    constructor(callback: IntersectionObserverCallback) {
      observerCallback = callback
    }
    observe() {}
    disconnect() {
      disconnected += 1
    }
  }

  const cleanup = observeOnceEngaged(
    element,
    () => {
      tracked += 1
    },
    {
      documentTarget,
      dwellMs: 750,
      Observer: FakeObserver,
      setTimer: ((callback: TimerHandler) => {
        scheduled = callback as () => void
        return 1
      }) as typeof setTimeout,
      clearTimer: (() => {
        cleared += 1
        scheduled = undefined
      }) as typeof clearTimeout,
    },
  )

  return {
    cleanup,
    documentTarget,
    enter(ratio = 0.25) {
      observerCallback?.(
        [
          {
            intersectionRatio: ratio,
            isIntersecting: true,
            target: element,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      )
    },
    exit() {
      observerCallback?.(
        [
          {
            intersectionRatio: 0,
            isIntersecting: false,
            target: element,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      )
    },
    fireTimer() {
      const callback = scheduled
      scheduled = undefined
      callback?.()
    },
    hide() {
      documentTarget.visibilityState = "hidden"
      listeners.forEach((listener) => listener())
    },
    show() {
      documentTarget.visibilityState = "visible"
      listeners.forEach((listener) => listener())
    },
    state() {
      return {
        cleared,
        disconnected,
        listeners: listeners.size,
        scheduled: Boolean(scheduled),
        tracked,
      }
    },
  }
}

test("offer section engagement requires continuous 25% visibility for the dwell window", () => {
  const harness = createHarness()

  harness.enter(0.24)
  assert.equal(harness.state().scheduled, false)

  harness.enter()
  assert.equal(harness.state().scheduled, true)
  harness.exit()
  assert.equal(harness.state().scheduled, false)
  harness.fireTimer()
  assert.equal(harness.state().tracked, 0)

  harness.enter()
  harness.fireTimer()
  assert.equal(harness.state().tracked, 1)
  assert.equal(harness.state().listeners, 0)
  assert.ok(harness.state().disconnected >= 1)

  harness.enter()
  harness.fireTimer()
  assert.equal(harness.state().tracked, 1)
})

test("offer section engagement pauses while the document is hidden and cleans up", () => {
  const harness = createHarness()

  harness.enter()
  harness.hide()
  assert.equal(harness.state().scheduled, false)
  harness.fireTimer()
  assert.equal(harness.state().tracked, 0)

  harness.show()
  assert.equal(harness.state().scheduled, true)
  harness.cleanup()
  assert.equal(harness.state().scheduled, false)
  assert.equal(harness.state().listeners, 0)
  assert.ok(harness.state().cleared >= 2)
})
