import assert from "node:assert/strict"
import test from "node:test"

import { customerIoDestination } from "../src/lib/analytics/destinations/customerio"
import { metaDestination } from "../src/lib/analytics/destinations/meta"
import { postHogDestination } from "../src/lib/analytics/destinations/posthog"
import {
  claimCheckoutFailure,
  type AppEventMap,
  type AppEventName,
} from "../src/lib/analytics/events"
import { eventRoutes } from "../src/lib/analytics/routes"
import { trackAppEvent } from "../src/lib/analytics/track-app-event"
import {
  clearCustomerIoBrowserClient,
  setCustomerIoBrowserClient,
} from "../src/lib/customerio-tracking"
import { posthog } from "../src/lib/analytics/runtime/posthog"
import { buildOfferViewedPayload } from "../src/lib/analytics/offer-viewed-payload"
import { initMetaPixel, trackMetaCheckoutStarted } from "../src/lib/meta-pixel"

type DestinationCall = {
  destination: "customerio" | "meta" | "posthog"
  eventName: AppEventName
  payload: AppEventMap[AppEventName]
}

function withDestinationSpies(fn: (calls: DestinationCall[]) => void) {
  const calls: DestinationCall[] = []
  const originalPostHog = postHogDestination.track
  const originalCustomerIo = customerIoDestination.track
  const originalMeta = metaDestination.track

  postHogDestination.track = ((eventName, payload) => {
    calls.push({ destination: "posthog", eventName, payload })
    return true
  }) as typeof postHogDestination.track
  customerIoDestination.track = ((eventName, payload) => {
    calls.push({ destination: "customerio", eventName, payload })
    return true
  }) as typeof customerIoDestination.track
  metaDestination.track = ((eventName, payload) => {
    calls.push({ destination: "meta", eventName, payload })
    return true
  }) as typeof metaDestination.track

  try {
    fn(calls)
  } finally {
    postHogDestination.track = originalPostHog
    customerIoDestination.track = originalCustomerIo
    metaDestination.track = originalMeta
  }
}

function createMetaDom(hostname = "chaarlie.de") {
  const insertedScripts: Array<{ async?: boolean; id?: string; src?: string }> = []
  const scriptParent = {
    insertBefore(node: { async?: boolean; id?: string; src?: string }) {
      insertedScripts.push(node)
    },
  }
  const doc = {
    getElementById: (id: string) => insertedScripts.find((script) => script.id === id) ?? null,
    createElement: () => ({ async: false, id: "", src: "" }),
    getElementsByTagName: () => [{ parentNode: scriptParent }],
    head: {
      appendChild: (node: { async?: boolean; id?: string; src?: string }) =>
        insertedScripts.push(node),
    },
  } as unknown as Document

  return {
    doc,
    insertedScripts,
    win: {
      location: { hostname },
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    } as unknown as Window & { fbq?: ((...args: unknown[]) => void) & { queue?: unknown[][] } },
  }
}

function withGlobalBrowser<T>(win: Window, doc: Document, fn: () => T) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc })

  try {
    return fn()
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }

    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument)
    } else {
      Reflect.deleteProperty(globalThis, "document")
    }
  }
}

async function withGlobalBrowserAsync<T>(win: Window, doc: Document, fn: () => Promise<T>) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc })

  try {
    return await fn()
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }

    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument)
    } else {
      Reflect.deleteProperty(globalThis, "document")
    }
  }
}

test("quiz step views route to PostHog, Customer.io, and Meta", () => {
  withDestinationSpies((calls) => {
    trackAppEvent("quiz_step_viewed", {
      stepName: "hair_texture",
      stepNumber: 2,
    })

    assert.deepEqual(
      calls.map((call) => call.destination),
      ["posthog", "customerio", "meta"],
    )
  })
})

test("purchase completion browser event routes to Meta only", () => {
  withDestinationSpies((calls) => {
    trackAppEvent("purchase_completed", {
      checkoutSessionId: "cs_test_123",
      currency: "EUR",
      interval: "month",
      paymentMethodType: undefined,
      planId: "premium_month",
      value: 14.99,
    })

    assert.deepEqual(
      calls.map((call) => call.destination),
      ["meta"],
    )
  })
})

test("browser revenue return events only route to Meta", () => {
  assert.equal(eventRoutes.purchase_completed.customerio, false)
  assert.equal(eventRoutes.subscription_started.customerio, false)
  assert.equal(eventRoutes.purchase_completed.posthog, false)
  assert.equal(eventRoutes.subscription_started.posthog, false)
  assert.equal(eventRoutes.purchase_completed.meta, true)
  assert.equal(eventRoutes.subscription_started.meta, true)
})

test("browser quiz lead capture does not route to Customer.io", () => {
  assert.equal(eventRoutes.quiz_lead_captured.customerio, false)
  assert.equal(eventRoutes.quiz_lead_captured.posthog, true)
  assert.equal(eventRoutes.quiz_lead_captured.meta, true)

  withDestinationSpies((calls) => {
    trackAppEvent("quiz_lead_captured", {
      leadId: "lead-123",
      marketingConsent: false,
    })

    assert.deepEqual(
      calls.map((call) => call.destination),
      ["posthog", "meta"],
    )
  })
})

test("non-funnel lifecycle and engagement events stay out of Meta", () => {
  withDestinationSpies((calls) => {
    trackAppEvent("first_chat_message", {})

    assert.deepEqual(
      calls.map((call) => `${call.eventName}:${call.destination}`),
      ["first_chat_message:posthog", "first_chat_message:customerio"],
    )
  })
})

test("facade strips undefined payload values once before destination dispatch", () => {
  withDestinationSpies((calls) => {
    trackAppEvent("pricing_viewed", {
      leadId: undefined,
      source: "pricing_page",
    })

    assert.deepEqual(calls[0].payload, { source: "pricing_page" })
    assert.deepEqual(calls[1].payload, { source: "pricing_page" })
    assert.deepEqual(calls[2].payload, { source: "pricing_page" })
  })
})

test("quiz completed analytics payload includes hair length when present", () => {
  withDestinationSpies((calls) => {
    trackAppEvent("quiz_completed", {
      hairLength: "medium",
      hairTexture: "wavy",
      leadId: "lead-123",
      scalpCondition: "gereizt",
      scalpType: "trocken",
      thickness: "fine",
    })

    const funnelEventId = (calls[0].payload as { funnelEventId?: string }).funnelEventId
    assert.equal(typeof funnelEventId, "string")
    assert.deepEqual(
      calls.map((call) => call.payload),
      [
        {
          funnelEventId,
          hairLength: "medium",
          hairTexture: "wavy",
          leadId: "lead-123",
          scalpCondition: "gereizt",
          scalpType: "trocken",
          thickness: "fine",
        },
        {
          funnelEventId,
          hairLength: "medium",
          hairTexture: "wavy",
          leadId: "lead-123",
          scalpCondition: "gereizt",
          scalpType: "trocken",
          thickness: "fine",
        },
        {
          funnelEventId,
          hairLength: "medium",
          hairTexture: "wavy",
          leadId: "lead-123",
          scalpCondition: "gereizt",
          scalpType: "trocken",
          thickness: "fine",
        },
      ],
    )
  })
})

test("destination failures are isolated and do not throw from the facade", () => {
  const originalPostHog = postHogDestination.track
  const originalCustomerIo = customerIoDestination.track
  const originalMeta = metaDestination.track
  const attempted: string[] = []

  postHogDestination.track = (() => {
    attempted.push("posthog")
    throw new Error("posthog unavailable")
  }) as typeof postHogDestination.track
  customerIoDestination.track = (() => {
    attempted.push("customerio")
    return true
  }) as typeof customerIoDestination.track
  metaDestination.track = (() => {
    attempted.push("meta")
    return true
  }) as typeof metaDestination.track

  try {
    trackAppEvent("quiz_step_viewed", {
      stepName: "hair_texture",
      stepNumber: 2,
    })

    assert.deepEqual(attempted, ["posthog", "customerio", "meta"])
  } finally {
    postHogDestination.track = originalPostHog
    customerIoDestination.track = originalCustomerIo
    metaDestination.track = originalMeta
  }
})

test("PostHog adapter strips undefined properties and sends the funnel package key", () => {
  const originalCapture = posthog.capture
  const calls: unknown[][] = []
  posthog.capture = ((...args: unknown[]) => {
    calls.push(args)
  }) as typeof posthog.capture

  try {
    postHogDestination.track("quiz_completed", {
      funnelPackageKey: "default_organic",
      hairTexture: "wavy",
      scalpCondition: undefined,
      scalpType: null,
      thickness: undefined,
    })

    assert.deepEqual(calls, [
      [
        "quiz_completed",
        {
          funnel_package_key: "default_organic",
          structure: "wavy",
          scalp_type: null,
        },
      ],
    ])
  } finally {
    posthog.capture = originalCapture
  }
})

test("offer diagnostics route only to PostHog with stable snake_case context", () => {
  const diagnosticEvents = [
    "checkout_start_failed",
    "offer_checkout_opened",
    "offer_cta_clicked",
    "offer_faq_opened",
    "offer_payment_method_selected",
    "offer_plan_selected",
    "offer_section_viewed",
  ] as const

  for (const eventName of diagnosticEvents) {
    assert.deepEqual(eventRoutes[eventName], {
      customerio: false,
      meta: false,
      posthog: true,
    })
  }

  const originalCapture = posthog.capture
  const calls: unknown[][] = []
  posthog.capture = ((...args: unknown[]) => {
    calls.push(args)
    return true
  }) as typeof posthog.capture

  try {
    postHogDestination.track("offer_section_viewed", {
      conditionerModuleId: "conditioner-moisture-normal",
      entryContext: "quiz_completion",
      focusRoutine: false,
      funnelEventId: "30000000-0000-4000-8000-000000000099",
      funnelPackageKey: "default_organic",
      funnelSessionId: "20000000-0000-4000-8000-000000000099",
      leadId: "10000000-0000-4000-8000-000000000099",
      needLane: "moisture",
      offerRevision: "product_led_v1",
      offerVariant: "default",
      offerViewId: "40000000-0000-4000-8000-000000000099",
      sectionId: "mini_routine",
      sectionIndex: 1,
      shampooModuleId: "shampoo-balanced-normal",
      suggestedCategory: "leave_in",
    })
  } finally {
    posthog.capture = originalCapture
  }

  assert.deepEqual(calls, [
    [
      "offer_section_viewed",
      {
        $insert_id: "30000000-0000-4000-8000-000000000099",
        conditioner_module_id: "conditioner-moisture-normal",
        entry_context: "quiz_completion",
        focus_routine: false,
        funnel_package_key: "default_organic",
        funnel_session_id: "20000000-0000-4000-8000-000000000099",
        lead_id: "10000000-0000-4000-8000-000000000099",
        need_lane: "moisture",
        offer_revision: "product_led_v1",
        offer_variant: "default",
        offer_view_id: "40000000-0000-4000-8000-000000000099",
        section_id: "mini_routine",
        section_index: 1,
        shampoo_module_id: "shampoo-balanced-normal",
        suggested_category: "leave_in",
      },
    ],
  ])
})

test("checkout failure dedupe is scoped to the attempt and stable failure branch", () => {
  const seen = new Set<string>()

  assert.equal(
    claimCheckoutFailure(
      seen,
      "50000000-0000-4000-8000-000000000001",
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    true,
  )
  assert.equal(
    claimCheckoutFailure(
      seen,
      "50000000-0000-4000-8000-000000000001",
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    false,
  )
  assert.equal(
    claimCheckoutFailure(
      seen,
      "50000000-0000-4000-8000-000000000002",
      "paypal",
      "provider_session",
      "paypal_js_load_failed",
    ),
    true,
  )
})

test("PostHog joins offer checkout diagnostics by checkout attempt", () => {
  const originalCapture = posthog.capture
  const calls: unknown[][] = []
  posthog.capture = ((...args: unknown[]) => {
    calls.push(args)
    return true
  }) as typeof posthog.capture

  try {
    postHogDestination.track("checkout_start_failed", {
      checkoutAttemptId: "50000000-0000-4000-8000-000000000001",
      conditionerModuleId: "conditioner-moisture-normal",
      currency: "EUR",
      entryContext: "quiz_completion",
      errorCode: "paypal_js_load_failed",
      failureStage: "provider_session",
      focusRoutine: false,
      interval: "quarter",
      needLane: "moisture",
      offerRevision: "product_led_v1",
      offerVariant: "default",
      offerViewId: "40000000-0000-4000-8000-000000000099",
      planId: "premium_quarter",
      provider: "paypal",
      retryable: true,
      shampooModuleId: "shampoo-balanced-normal",
      suggestedCategory: "leave_in",
      value: 34.99,
    })
  } finally {
    posthog.capture = originalCapture
  }

  assert.equal(
    (calls[0]?.[1] as Record<string, unknown>)?.checkout_attempt_id,
    "50000000-0000-4000-8000-000000000001",
  )
  assert.equal((calls[0]?.[1] as Record<string, unknown>)?.error_code, "paypal_js_load_failed")
  assert.equal((calls[0]?.[1] as Record<string, unknown>)?.sdk_error, undefined)
})

test("PostHog pricing view keeps offer diagnostics alongside historical pricing fields", () => {
  const originalCapture = posthog.capture
  const calls: unknown[][] = []
  posthog.capture = ((...args: unknown[]) => {
    calls.push(args)
    return true
  }) as typeof posthog.capture

  try {
    postHogDestination.track("pricing_viewed", {
      availableIntervals: ["month", "quarter", "year"],
      entryContext: "saved_result",
      focusRoutine: false,
      funnelEventId: "30000000-0000-4000-8000-000000000097",
      leadId: "10000000-0000-4000-8000-000000000097",
      needLane: "protein",
      offerRevision: "product_led_v1",
      offerVariant: "default",
      offerViewId: "40000000-0000-4000-8000-000000000097",
      pricingRevision: "pricing_v1",
      selectedInterval: "quarter",
      source: "quiz_result_offer_pricing",
      suggestedCategory: "protein_mask",
    })
  } finally {
    posthog.capture = originalCapture
  }

  assert.deepEqual(calls, [
    [
      "pricing_viewed",
      {
        $insert_id: "30000000-0000-4000-8000-000000000097",
        available_intervals: ["month", "quarter", "year"],
        entry_context: "saved_result",
        focus_routine: false,
        leadId: "10000000-0000-4000-8000-000000000097",
        lead_id: "10000000-0000-4000-8000-000000000097",
        need_lane: "protein",
        offer_revision: "product_led_v1",
        offer_variant: "default",
        offer_view_id: "40000000-0000-4000-8000-000000000097",
        pricing_revision: "pricing_v1",
        selected_interval: "quarter",
        source: "quiz_result_offer_pricing",
        suggested_category: "protein_mask",
      },
    ],
  ])
})

test("offer view payload only reuses a funnel event ID that was already persisted", () => {
  const context = {
    entryContext: "quiz_completion" as const,
    focusRoutine: false,
    funnelPackageKey: "default_organic",
    funnelSessionId: "20000000-0000-4000-8000-000000000096",
    leadId: "10000000-0000-4000-8000-000000000096",
    needLane: "moisture",
    offerRevision: "product_led_v1",
    offerVariant: "default",
    offerViewId: "40000000-0000-4000-8000-000000000096",
  }

  const inQuizPayload = buildOfferViewedPayload(context)
  assert.equal("funnelEventId" in inQuizPayload, false)

  const savedResultPayload = buildOfferViewedPayload(
    context,
    "30000000-0000-4000-8000-000000000096",
  )
  assert.equal(savedResultPayload.funnelEventId, "30000000-0000-4000-8000-000000000096")
})

test("offer view facade persists a new browser milestone but does not duplicate a server milestone", () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ body?: BodyInit | null; method?: string }> = []
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: init?.body, method: init?.method })
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  }) as typeof fetch

  const context = {
    entryContext: "quiz_completion" as const,
    focusRoutine: false,
    needLane: "moisture",
    offerRevision: "product_led_v1",
    offerVariant: "default",
    offerViewId: "40000000-0000-4000-8000-000000000094",
  }

  try {
    withDestinationSpies(() => {
      trackAppEvent("offer_viewed", buildOfferViewedPayload(context))
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "POST")
    assert.equal(JSON.parse(String(requests[0].body)).milestone, "offer_viewed")

    requests.length = 0
    withDestinationSpies(() => {
      trackAppEvent(
        "offer_viewed",
        buildOfferViewedPayload(context, "30000000-0000-4000-8000-000000000094"),
      )
    })
    assert.equal(requests.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PostHog checkout start keeps offer context and commerce metadata", () => {
  const originalCapture = posthog.capture
  const calls: unknown[][] = []
  posthog.capture = ((...args: unknown[]) => {
    calls.push(args)
    return true
  }) as typeof posthog.capture

  try {
    postHogDestination.track("checkout_started", {
      checkoutAttemptId: "50000000-0000-4000-8000-000000000095",
      currency: "EUR",
      entryContext: "quiz_completion",
      focusRoutine: false,
      funnelEventId: "30000000-0000-4000-8000-000000000095",
      funnelPackageKey: "default_organic",
      funnelSessionId: "20000000-0000-4000-8000-000000000095",
      interval: "year",
      leadId: "10000000-0000-4000-8000-000000000095",
      needLane: "moisture",
      offerRevision: "product_led_v1",
      offerVariant: "default",
      offerViewId: "40000000-0000-4000-8000-000000000095",
      planId: "premium_year",
      provider: "stripe",
      source: "quiz_result_offer",
      value: 99.99,
    })
  } finally {
    posthog.capture = originalCapture
  }

  assert.deepEqual(calls, [
    [
      "checkout_started",
      {
        $insert_id: "30000000-0000-4000-8000-000000000095",
        checkout_attempt_id: "50000000-0000-4000-8000-000000000095",
        currency: "EUR",
        entry_context: "quiz_completion",
        focus_routine: false,
        funnel_package_key: "default_organic",
        funnel_session_id: "20000000-0000-4000-8000-000000000095",
        interval: "year",
        leadId: "10000000-0000-4000-8000-000000000095",
        lead_id: "10000000-0000-4000-8000-000000000095",
        need_lane: "moisture",
        offer_revision: "product_led_v1",
        offer_variant: "default",
        offer_view_id: "40000000-0000-4000-8000-000000000095",
        plan_id: "premium_year",
        provider: "stripe",
        source: "quiz_result_offer",
        value: 99.99,
      },
    ],
  ])
})

test("profile reactivation context reaches PostHog and Customer.io", () => {
  const postHogCalls: unknown[][] = []
  const customerIoCalls: unknown[][] = []
  const originalCapture = posthog.capture
  posthog.capture = ((...args: unknown[]) => {
    postHogCalls.push(args)
    return true
  }) as typeof posthog.capture
  setCustomerIoBrowserClient({
    identify: () => undefined,
    page: () => undefined,
    reset: () => undefined,
    track: (...args: unknown[]) => customerIoCalls.push(args),
  })

  const payload = {
    checkoutAttemptId: "50000000-0000-4000-8000-000000000096",
    checkoutContext: "membership_reactivation" as const,
    currency: "EUR",
    funnelPackageKey: "membership_reactivation",
    funnelSessionId: "20000000-0000-4000-8000-000000000096",
    interval: "quarter" as const,
    planId: "premium_quarter",
    provider: "stripe" as const,
    source: "pricing_page" as const,
    value: 34.99,
  }

  try {
    postHogDestination.track("checkout_started", payload)
    customerIoDestination.track("checkout_started", payload)
  } finally {
    posthog.capture = originalCapture
    clearCustomerIoBrowserClient()
  }

  assert.equal(
    (postHogCalls[0]?.[1] as Record<string, unknown>)?.checkout_context,
    "membership_reactivation",
  )
  assert.equal(
    (customerIoCalls[0]?.[1] as Record<string, unknown>)?.checkout_context,
    "membership_reactivation",
  )
})

test("Customer.io adapter maps app payloads to snake_case vendor payloads", () => {
  const calls: unknown[][] = []

  setCustomerIoBrowserClient({
    identify: () => undefined,
    page: () => undefined,
    reset: () => undefined,
    track: (...args: unknown[]) => calls.push(args),
  })

  try {
    assert.equal(
      customerIoDestination.track("purchase_completed", {
        checkoutSessionId: "cs_test_123",
        currency: "eur",
        interval: "month",
        paymentMethodType: undefined,
        planId: "premium_month",
        value: 14.99,
      }),
      true,
    )

    assert.deepEqual(calls, [
      [
        "purchase_completed",
        {
          checkout_session_id: "cs_test_123",
          currency: "EUR",
          interval: "month",
          plan_id: "premium_month",
          value: 14.99,
        },
      ],
    ])
  } finally {
    clearCustomerIoBrowserClient()
  }
})

test("Meta adapter builds purchase payload from app-owned checkout fields", () => {
  const dom = createMetaDom()

  withGlobalBrowser(dom.win, dom.doc, () => {
    assert.equal(
      metaDestination.track("purchase_completed", {
        checkoutSessionId: "cs_test_purchase",
        currency: "eur",
        interval: "quarter",
        paymentMethodType: "card",
        planId: "premium_quarter",
        value: 34.99,
      }),
      true,
    )
  })

  assert.deepEqual(dom.win.fbq?.queue, [
    ["init", "988892550357504"],
    [
      "track",
      "Purchase",
      {
        content_ids: ["premium_quarter"],
        content_name: "premium_subscription",
        content_type: "product",
        currency: "EUR",
        payment_method_type: "card",
        subscription_interval: "quarter",
        value: 34.99,
      },
      { eventID: "cs_test_purchase" },
    ],
  ])
})

test("Meta purchase initialization respects the local vendor analytics boundary", () => {
  const previous = process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS

  try {
    delete process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS

    for (const hostname of ["localhost", "127.0.0.1"]) {
      const dom = createMetaDom(hostname)
      withGlobalBrowser(dom.win, dom.doc, () => {
        assert.equal(initMetaPixel(), false)
        assert.equal(
          metaDestination.track("purchase_completed", {
            checkoutSessionId: `cs_local_${hostname}`,
            currency: "eur",
            interval: "month",
            planId: "premium_month",
            value: 14.99,
          }),
          false,
        )
      })

      assert.equal(dom.insertedScripts.length, 0)
      assert.equal(dom.win.fbq, undefined)
    }

    process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS = "true"
    const allowedDom = createMetaDom("localhost")
    withGlobalBrowser(allowedDom.win, allowedDom.doc, () => {
      assert.equal(
        metaDestination.track("purchase_completed", {
          checkoutSessionId: "cs_local_override",
          currency: "eur",
          interval: "month",
          planId: "premium_month",
          value: 14.99,
        }),
        true,
      )
    })

    assert.equal(allowedDom.insertedScripts.length, 1)
    assert.deepEqual(
      allowedDom.win.fbq?.queue?.map((call) => call.slice(0, 2)),
      [
        ["init", "988892550357504"],
        ["track", "Purchase"],
      ],
    )
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS
    else process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS = previous
  }
})

test("Meta purchase includes the package key behind the browser custom-data flag", () => {
  const previous = process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
  const dom = createMetaDom()

  try {
    process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = "true"
    withGlobalBrowser(dom.win, dom.doc, () => {
      assert.equal(
        metaDestination.track("purchase_completed", {
          checkoutSessionId: "cs_test_package_purchase",
          currency: "eur",
          funnelPackageKey: "scalp_check_placeholder",
          interval: "month",
          planId: "premium_month",
          value: 14.99,
        }),
        true,
      )
    })
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
    else process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = previous
  }

  const purchasePayload = dom.win.fbq?.queue?.find((call) => call[1] === "Purchase")?.[2] as Record<
    string,
    unknown
  >
  assert.equal(purchasePayload.funnel_package_key, "scalp_check_placeholder")
})

test("Meta adapter gates package keys and never sends funnel session IDs", () => {
  const previous = process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
  const calls: unknown[][][] = []

  try {
    for (const enabled of [undefined, "true"]) {
      if (enabled) process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = enabled
      else delete process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED

      const dom = createMetaDom()
      withGlobalBrowser(dom.win, dom.doc, () => {
        initMetaPixel({ win: dom.win, doc: dom.doc })
        metaDestination.track("checkout_started", {
          provider: "stripe",
          source: "pricing_page",
          funnelEventId: "30000000-0000-4000-8000-000000000003",
          funnelPackageKey: "scalp_check_placeholder",
          funnelSessionId: "20000000-0000-4000-8000-000000000002",
        })
      })
      calls.push(dom.win.fbq?.queue ?? [])
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
    else process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = previous
  }

  const disabledPayload = calls[0][1][2] as Record<string, unknown>
  const enabledPayload = calls[1][1][2] as Record<string, unknown>
  assert.equal(disabledPayload.funnel_package_key, undefined)
  assert.equal(enabledPayload.funnel_package_key, "scalp_check_placeholder")
  assert.equal(JSON.stringify(calls).includes("20000000-0000-4000-8000-000000000002"), false)
})

test("Meta checkout-start payload includes structured commerce metadata", () => {
  const dom = createMetaDom()

  withGlobalBrowser(dom.win, dom.doc, () => {
    initMetaPixel({ win: dom.win, doc: dom.doc })
    assert.equal(
      trackMetaCheckoutStarted(
        "quiz_result_offer",
        "quarter",
        { currency: "EUR", planId: "premium_quarter", value: 34.99 },
        "30000000-0000-4000-8000-000000000098",
      ),
      true,
    )
  })

  assert.deepEqual(dom.win.fbq?.queue?.[1], [
    "track",
    "InitiateCheckout",
    {
      content_ids: ["premium_quarter"],
      content_name: "quiz_result_offer",
      currency: "EUR",
      interval: "quarter",
      value: 34.99,
    },
    { eventID: "30000000-0000-4000-8000-000000000098" },
  ])
})

test("Meta preserves early quiz event order while waiting for the sticky funnel package", async () => {
  const previousFlag = process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
  const originalFetch = globalThis.fetch
  const dom = createMetaDom()
  let resolveFetch: ((response: Response) => void) | undefined

  try {
    process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = "true"
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })) as typeof fetch

    await withGlobalBrowserAsync(dom.win, dom.doc, async () => {
      assert.equal(
        metaDestination.track("quiz_started", {
          funnelEventId: "30000000-0000-4000-8000-000000000003",
          stepName: "hair_texture",
          stepNumber: 1,
        }),
        true,
      )
      assert.equal(
        metaDestination.track("quiz_step_viewed", {
          stepName: "hair_texture",
          stepNumber: 1,
        }),
        true,
      )
      assert.equal(
        metaDestination.track("pricing_viewed", {
          funnelEventId: "30000000-0000-4000-8000-000000000004",
          funnelPackageKey: "default_organic",
          source: "pricing_page",
        }),
        true,
      )

      initMetaPixel({ win: dom.win, doc: dom.doc })
      const dispatched: unknown[][] = []
      dom.win.fbq = (...args: unknown[]) => {
        dispatched.push(args)
        if (args[1] === "QuizStarted") throw new Error("synthetic Meta dispatch failure")
      }

      resolveFetch?.(
        new Response(
          JSON.stringify({
            funnelPackageKey: "default_organic",
            funnelSessionId: "20000000-0000-4000-8000-000000000002",
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      const quizStartedPayload = dispatched.find(
        (call) => call[1] === "QuizStarted",
      )?.[2] as Record<string, unknown>
      assert.equal(quizStartedPayload.funnel_package_key, "default_organic")
      assert.deepEqual(
        dispatched
          .filter(
            (call) =>
              call[1] === "QuizStarted" ||
              call[1] === "QuizStepViewed" ||
              call[1] === "ViewContent",
          )
          .map((call) => call[1]),
        ["QuizStarted", "QuizStepViewed", "ViewContent"],
      )
    })
  } finally {
    globalThis.fetch = originalFetch
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED
    else process.env.NEXT_PUBLIC_FUNNEL_META_CUSTOM_DATA_ENABLED = previousFlag
  }
})
