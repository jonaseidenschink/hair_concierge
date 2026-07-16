import { shouldInitializeBrowserVendorAnalytics } from "@/lib/analytics/runtime/environment"
import { isFunnelMetaBrowserCustomDataEnabled } from "@/lib/funnel/flags"

const DEFAULT_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "988892550357504"
const META_SCRIPT_ID = "meta-pixel-script"
const META_SCRIPT_SRC = "https://connect.facebook.net/en_US/fbevents.js"
const SUBSCRIPTION_TRACKED_STORAGE_PREFIX = "chaarlie_meta_subscribe_tracked:"
const PURCHASE_TRACKED_STORAGE_PREFIX = "chaarlie_meta_purchase_tracked:"

type MetaEventValue = string | number | boolean | null | undefined | string[]
export type MetaEventProperties = Record<string, MetaEventValue>
export type MetaStandardEvent =
  | "PageView"
  | "Lead"
  | "InitiateCheckout"
  | "Purchase"
  | "Subscribe"
  | "CompleteRegistration"
  | "ViewContent"

type Fbq = ((command: string, ...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void
  loaded?: boolean
  push?: Fbq
  queue?: unknown[][]
  version?: string
}

type MetaWindow = {
  _fbq?: Fbq
  fbq?: Fbq
  location?: { hostname?: string }
}

type BrowserTargets = {
  doc?: Document
  hostname?: string
  localVendorAnalyticsOverride?: boolean
  pixelId?: string
  win?: MetaWindow
}

type MetaTrackOptions = BrowserTargets & {
  eventID?: string
  onDispatched?: () => void
}

type QueuedMetaEvent = {
  eventName: string
  kind: "custom" | "standard"
  options: Pick<MetaTrackOptions, "eventID" | "onDispatched">
  properties?: MetaEventProperties
}

export type MetaPurchasePayload = {
  contentId: string
  currency: string
  eventId: string
  funnelPackageKey?: string | null
  interval: string
  paymentMethodType?: string
  value: number
}

const initializedPixelsByWindow = new WeakMap<object, Set<string>>()
const queuedEventsByWindow = new WeakMap<object, QueuedMetaEvent[]>()
const pendingSubscriptionsByWindow = new WeakMap<object, Set<string>>()

function getBrowserTargets(options: BrowserTargets = {}) {
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  const doc = options.doc ?? (typeof document === "undefined" ? undefined : document)
  return {
    doc,
    hostname: options.hostname ?? win?.location?.hostname,
    pixelId: options.pixelId ?? DEFAULT_PIXEL_ID,
    win,
  }
}

function sanitizeProperties(properties?: MetaEventProperties) {
  if (!properties) return undefined

  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<MetaEventValue, undefined>>
}

function installFbq(win: MetaWindow, doc: Document) {
  if (!win.fbq) {
    const fbq = ((command: string, ...args: unknown[]) => {
      if (fbq.callMethod) {
        fbq.callMethod(command, ...args)
        return
      }
      fbq.queue?.push([command, ...args])
    }) as Fbq

    fbq.push = fbq
    fbq.loaded = true
    fbq.version = "2.0"
    fbq.queue = []
    win.fbq = fbq
    win._fbq = fbq
  }

  if (doc.getElementById(META_SCRIPT_ID)) return

  const script = doc.createElement("script")
  script.id = META_SCRIPT_ID
  script.async = true
  script.src = META_SCRIPT_SRC

  const firstScript = doc.getElementsByTagName("script")[0]
  if (firstScript?.parentNode) {
    firstScript.parentNode.insertBefore(script, firstScript)
    return
  }

  doc.head.appendChild(script)
}

export function initMetaPixel(options: BrowserTargets = {}) {
  const { doc, hostname, pixelId, win } = getBrowserTargets(options)
  if (!pixelId || !win || !doc) return false
  if (!shouldInitializeBrowserVendorAnalytics(hostname, options.localVendorAnalyticsOverride)) {
    return false
  }

  installFbq(win, doc)

  const initializedPixels = initializedPixelsByWindow.get(win) ?? new Set<string>()
  if (!initializedPixels.has(pixelId)) {
    win.fbq?.("init", pixelId)
    initializedPixels.add(pixelId)
    initializedPixelsByWindow.set(win, initializedPixels)
  }

  flushQueuedMetaEvents(win)
  return true
}

export function isMetaPixelReady(options: Pick<BrowserTargets, "win"> = {}) {
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  if (!win?.fbq) return false
  return Boolean(initializedPixelsByWindow.get(win)?.size)
}

function queueMetaEvent(
  win: MetaWindow,
  kind: QueuedMetaEvent["kind"],
  eventName: string,
  properties?: MetaEventProperties,
  options: MetaTrackOptions = {},
) {
  const queuedEvents = queuedEventsByWindow.get(win) ?? []
  queuedEvents.push({
    eventName,
    kind,
    options: { eventID: options.eventID, onDispatched: options.onDispatched },
    properties,
  })
  queuedEventsByWindow.set(win, queuedEvents)
}

function flushQueuedMetaEvents(win: MetaWindow) {
  if (!win.fbq || !isMetaPixelReady({ win })) return

  const queuedEvents = queuedEventsByWindow.get(win)
  if (!queuedEvents?.length) return

  queuedEventsByWindow.delete(win)
  for (const queuedEvent of queuedEvents) {
    if (queuedEvent.kind === "custom") {
      dispatchMetaCustomEvent(queuedEvent.eventName, queuedEvent.properties, {
        ...queuedEvent.options,
        win,
      })
    } else {
      dispatchMetaEvent(queuedEvent.eventName as MetaStandardEvent, queuedEvent.properties, {
        ...queuedEvent.options,
        win,
      })
    }
  }
}

function getBrowserSessionStorage(win: MetaWindow | undefined) {
  if (!win) return undefined
  try {
    if (typeof window !== "undefined" && win === window) return window.sessionStorage
    return (win as MetaWindow & { sessionStorage?: Storage }).sessionStorage
  } catch {
    return undefined
  }
}

function safeStorageGet(storage: Storage | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeStorageSet(storage: Storage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value)
  } catch {
    // Tracking storage is best effort; never let analytics block checkout flow.
  }
}

export function trackMetaEvent(
  eventName: MetaStandardEvent,
  properties?: MetaEventProperties,
  options: MetaTrackOptions = {},
) {
  return dispatchMetaEvent(eventName, properties, options)
}

function dispatchMetaEvent(
  eventName: MetaStandardEvent,
  properties?: MetaEventProperties,
  options: MetaTrackOptions = {},
) {
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  if (!win) return false
  if (!win.fbq || !isMetaPixelReady({ win })) {
    queueMetaEvent(win, "standard", eventName, properties, options)
    return true
  }

  const cleanProperties = sanitizeProperties(properties)
  const eventOptions = options.eventID ? { eventID: options.eventID } : undefined

  if (cleanProperties && Object.keys(cleanProperties).length > 0) {
    if (eventOptions) {
      win.fbq("track", eventName, cleanProperties, eventOptions)
    } else {
      win.fbq("track", eventName, cleanProperties)
    }
  } else if (eventOptions) {
    win.fbq("track", eventName, {}, eventOptions)
  } else {
    win.fbq("track", eventName)
  }

  options.onDispatched?.()
  return true
}

export function trackMetaCustomEvent(
  eventName: string,
  properties?: MetaEventProperties,
  options: Pick<BrowserTargets, "win"> & Pick<MetaTrackOptions, "eventID" | "onDispatched"> = {},
) {
  return dispatchMetaCustomEvent(eventName, properties, options)
}

function dispatchMetaCustomEvent(
  eventName: string,
  properties?: MetaEventProperties,
  options: Pick<BrowserTargets, "win"> & Pick<MetaTrackOptions, "eventID" | "onDispatched"> = {},
) {
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  if (!win) return false
  if (!win.fbq || !isMetaPixelReady({ win })) {
    queueMetaEvent(win, "custom", eventName, properties, options)
    return true
  }

  const cleanProperties = sanitizeProperties(properties)
  const eventOptions = options.eventID ? { eventID: options.eventID } : undefined
  if (cleanProperties && Object.keys(cleanProperties).length > 0) {
    if (eventOptions) {
      win.fbq("trackCustom", eventName, cleanProperties, eventOptions)
    } else {
      win.fbq("trackCustom", eventName, cleanProperties)
    }
  } else if (eventOptions) {
    win.fbq("trackCustom", eventName, {}, eventOptions)
  } else {
    win.fbq("trackCustom", eventName)
  }
  options.onDispatched?.()
  return true
}

export function trackMetaPageView(options: Pick<BrowserTargets, "win"> = {}) {
  return trackMetaEvent("PageView", undefined, options)
}

function funnelPackageProperties(packageKey?: string | null): MetaEventProperties {
  return isFunnelMetaBrowserCustomDataEnabled() && packageKey
    ? { funnel_package_key: packageKey }
    : {}
}

export function trackMetaQuizStarted(
  stepName: string,
  stepNumber: number,
  eventID?: string | null,
  packageKey?: string | null,
) {
  return trackMetaCustomEvent(
    "QuizStarted",
    {
      step_name: stepName,
      step_number: stepNumber,
      ...funnelPackageProperties(packageKey),
    },
    { eventID: eventID ?? undefined },
  )
}

export function trackMetaQuizStepViewed(stepName: string, stepNumber: number) {
  return trackMetaCustomEvent("QuizStepViewed", {
    step_name: stepName,
    step_number: stepNumber,
  })
}

export function trackMetaQuizCompleted(eventID?: string | null, packageKey?: string | null) {
  const properties = {
    content_name: "quiz",
    funnel_step: "quiz_completed",
    ...funnelPackageProperties(packageKey),
  }
  const standardTracked = trackMetaEvent("CompleteRegistration", properties, {
    eventID: eventID ?? undefined,
  })
  const customTracked = trackMetaCustomEvent("QuizCompleted", properties, {
    eventID: eventID ?? undefined,
  })
  return standardTracked || customTracked
}

export function trackMetaLeadCaptured(
  marketingConsent: boolean,
  eventID?: string | null,
  packageKey?: string | null,
) {
  return trackMetaEvent(
    "Lead",
    {
      content_name: "quiz_lead_capture",
      marketing_consent: marketingConsent,
      ...funnelPackageProperties(packageKey),
    },
    { eventID: eventID ?? undefined },
  )
}

export function trackMetaPricingViewed(
  source: "pricing_page" | "quiz_result_offer_pricing",
  eventID?: string | null,
  packageKey?: string | null,
) {
  return trackMetaEvent(
    "ViewContent",
    {
      content_name: source,
      ...funnelPackageProperties(packageKey),
    },
    { eventID: eventID ?? undefined },
  )
}

export function trackMetaCheckoutStarted(
  source: "pricing_page" | "quiz_result_offer",
  interval: string | null,
  commerce: { currency?: string; planId?: string; value?: number } = {},
  eventID?: string | null,
  packageKey?: string | null,
) {
  return trackMetaEvent(
    "InitiateCheckout",
    {
      content_name: source,
      content_ids: commerce.planId ? [commerce.planId] : undefined,
      currency: commerce.currency,
      interval,
      value: commerce.value,
      ...funnelPackageProperties(packageKey),
    },
    { eventID: eventID ?? undefined },
  )
}

export function trackMetaSubscriptionConfirmed(
  sessionId: string,
  options: Pick<BrowserTargets, "win"> = {},
) {
  let storageKey: string | null = null
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  const storage = getBrowserSessionStorage(win)
  if (storage) {
    storageKey = `${SUBSCRIPTION_TRACKED_STORAGE_PREFIX}${sessionId}`
    if (safeStorageGet(storage, storageKey) === "1") return false
  }

  const pendingSubscriptions = win
    ? (pendingSubscriptionsByWindow.get(win) ?? new Set<string>())
    : null
  if (storageKey && pendingSubscriptions?.has(storageKey)) return false
  if (win && pendingSubscriptions) pendingSubscriptionsByWindow.set(win, pendingSubscriptions)
  if (storageKey) pendingSubscriptions?.add(storageKey)

  const tracked = trackMetaEvent(
    "Subscribe",
    {
      content_name: "premium_subscription",
    },
    {
      ...options,
      eventID: sessionId,
      onDispatched: () => {
        if (!storageKey) return
        pendingSubscriptions?.delete(storageKey)
        safeStorageSet(storage, storageKey, "1")
      },
    },
  )

  if (!tracked && storageKey) pendingSubscriptions?.delete(storageKey)

  return tracked
}

export function trackMetaPurchaseConfirmed(
  purchase: MetaPurchasePayload,
  options: BrowserTargets = {},
) {
  let storageKey: string | null = null
  const win =
    options.win ?? (typeof window === "undefined" ? undefined : (window as unknown as MetaWindow))
  const storage = getBrowserSessionStorage(win)

  if (storage) {
    storageKey = `${PURCHASE_TRACKED_STORAGE_PREFIX}${purchase.eventId}`
    if (safeStorageGet(storage, storageKey) === "1") return false
  }

  if (!initMetaPixel(options)) return false

  const tracked = dispatchMetaEvent(
    "Purchase",
    {
      content_ids: [purchase.contentId],
      content_name: "premium_subscription",
      content_type: "product",
      currency: purchase.currency.toUpperCase(),
      ...funnelPackageProperties(purchase.funnelPackageKey),
      payment_method_type: purchase.paymentMethodType,
      subscription_interval: purchase.interval,
      value: purchase.value,
    },
    {
      ...options,
      eventID: purchase.eventId,
      onDispatched: () => {
        if (storageKey) safeStorageSet(storage, storageKey, "1")
      },
    },
  )

  return tracked
}
