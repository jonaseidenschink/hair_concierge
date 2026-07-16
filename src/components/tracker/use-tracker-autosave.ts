"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { TrackerSaveCoordinator, type TrackerSaveState } from "@/lib/tracking/save-coordinator"
import type { TrackerDayType, TrackerLogDay, TrackerLogProduct } from "@/lib/tracking/types"

const STATUS_DELAY_MS = 300

export type TrackerSaveMutation =
  | {
      kind: "save"
      loggedOn: string
      timezone: string
      dayType: TrackerDayType
      customActivityName: string | null
      products: TrackerLogProduct[]
    }
  | {
      kind: "delete"
      loggedOn: string
      timezone: string
    }

class TrackerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function makeClientSessionId(): string {
  return globalThis.crypto.randomUUID()
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === "string") return body.error
  } catch {
    // The generic fallback below is intentionally stable for non-JSON failures.
  }
  return "Konnte nicht gespeichert werden."
}

export function getPricingRedirectTarget(
  response: Pick<Response, "redirected" | "url">,
): string | null {
  if (!response.redirected) return null
  const url = new URL(response.url, window.location.origin)
  if (url.origin !== window.location.origin || url.pathname !== "/pricing") return null
  return `${url.pathname}${url.search}`
}

export function useTrackerAutosave(options: {
  onQueueIdle?: () => void
  onPersisted?: (result: {
    kind: TrackerSaveMutation["kind"]
    loggedOn: string
    day: TrackerLogDay | null
  }) => void
}) {
  const [clientSessionId] = useState(makeClientSessionId)
  const [visibleStates, setVisibleStates] = useState<Record<string, TrackerSaveState>>({})
  const rawStatesRef = useRef(new Map<string, TrackerSaveState>())
  const statusTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const latestRevisionsRef = useRef(new Map<string, number>())
  const onQueueIdleRef = useRef(options.onQueueIdle)
  const onPersistedRef = useRef(options.onPersisted)
  useEffect(() => {
    onQueueIdleRef.current = options.onQueueIdle
    onPersistedRef.current = options.onPersisted
  }, [options.onQueueIdle, options.onPersisted])

  const [coordinator, setCoordinator] =
    useState<TrackerSaveCoordinator<TrackerSaveMutation> | null>(null)

  useEffect(() => {
    const statusTimers = statusTimersRef.current
    const instance = new TrackerSaveCoordinator<TrackerSaveMutation>({
      keyOf: (payload) => payload.loggedOn,
      shouldRetry: (error) => !(error instanceof TrackerRequestError) || error.status >= 500,
      onIdle: () => onQueueIdleRef.current?.(),
      onStateChange: (key, state) => {
        rawStatesRef.current.set(key, state)
        const existingTimer = statusTimersRef.current.get(key)

        if (state.status === "pending" || state.status === "saving") {
          if (existingTimer) return
          const timer = setTimeout(() => {
            statusTimersRef.current.delete(key)
            const latest = rawStatesRef.current.get(key)
            if (latest?.status !== "pending" && latest?.status !== "saving") return
            setVisibleStates((previous) => ({ ...previous, [key]: latest }))
          }, STATUS_DELAY_MS)
          statusTimersRef.current.set(key, timer)
          return
        }

        if (existingTimer) {
          clearTimeout(existingTimer)
          statusTimersRef.current.delete(key)
        }
        setVisibleStates((previous) => ({ ...previous, [key]: state }))
      },
      save: async (payload, context) => {
        const response = await fetch("/api/tracker/log", {
          method: payload.kind === "delete" ? "DELETE" : "PUT",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            ...payload,
            kind: undefined,
            clientSessionId,
            clientRevision: context.revision,
          }),
        })
        const pricingRedirect = getPricingRedirectTarget(response)
        if (pricingRedirect) {
          window.location.assign(pricingRedirect)
          throw new TrackerRequestError("Zugang erforderlich.", 403)
        }
        if (!response.ok) {
          if (response.status === 403) {
            window.location.assign("/reactivate?reason=expired&next=%2Ftracker")
          }
          throw new TrackerRequestError(await parseError(response), response.status)
        }
        const body = (await response.json()) as {
          day?: TrackerLogDay & { deletedAt?: string | null }
        }
        if (latestRevisionsRef.current.get(payload.loggedOn) !== context.revision) return
        onPersistedRef.current?.({
          kind: payload.kind,
          loggedOn: payload.loggedOn,
          day: payload.kind === "delete" || body.day?.deletedAt ? null : (body.day ?? null),
        })
      },
    })
    setCoordinator(instance)
    return () => {
      for (const timer of statusTimers.values()) clearTimeout(timer)
      statusTimers.clear()
      onQueueIdleRef.current = undefined
      onPersistedRef.current = undefined
      void instance.flush().finally(() => instance.dispose())
    }
  }, [clientSessionId])

  useEffect(() => {
    if (!coordinator) return
    const flushOnHide = () => {
      void coordinator.flush()
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushOnHide()
    }

    window.addEventListener("pagehide", flushOnHide)
    document.addEventListener("visibilitychange", flushWhenHidden)
    return () => {
      window.removeEventListener("pagehide", flushOnHide)
      document.removeEventListener("visibilitychange", flushWhenHidden)
    }
  }, [coordinator])

  const queueSave = useCallback(
    (payload: TrackerSaveMutation) => {
      if (!coordinator) throw new Error("Tracker autosave is not ready")
      const revision = coordinator.queueSave(payload)
      latestRevisionsRef.current.set(payload.loggedOn, revision)
      return revision
    },
    [coordinator],
  )

  const retry = useCallback(
    (loggedOn: string) => coordinator?.retry(loggedOn) ?? false,
    [coordinator],
  )

  const discardPending = useCallback(
    (loggedOn: string) => {
      if (!coordinator) return 0
      const revision = coordinator.supersede(loggedOn)
      latestRevisionsRef.current.set(loggedOn, revision)
      return revision
    },
    [coordinator],
  )

  const hasDispatched = useCallback(
    (loggedOn: string) => coordinator?.hasDispatched(loggedOn) ?? false,
    [coordinator],
  )

  const flush = useCallback(() => coordinator?.flush() ?? Promise.resolve(), [coordinator])

  const getState = useCallback(
    (loggedOn: string): TrackerSaveState =>
      visibleStates[loggedOn] ?? { revision: 0, status: "idle", error: null },
    [visibleStates],
  )

  const getRawState = useCallback(
    (loggedOn: string): TrackerSaveState =>
      rawStatesRef.current.get(loggedOn) ?? { revision: 0, status: "idle", error: null },
    [],
  )

  return {
    clientSessionId,
    ready: coordinator !== null,
    queueSave,
    discardPending,
    hasDispatched,
    retry,
    flush,
    getState,
    getRawState,
  }
}
