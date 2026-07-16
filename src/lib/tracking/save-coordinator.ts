export type TrackerSaveStatus = "idle" | "pending" | "saving" | "saved" | "error"

export interface TrackerSaveState {
  revision: number
  status: TrackerSaveStatus
  error: unknown | null
}

export interface SaveAttemptContext {
  revision: number
  attempt: 1 | 2
}

interface PendingEntry<TPayload> {
  key: string
  payload: TPayload
  revision: number
}

interface FailedEntry<TPayload> extends PendingEntry<TPayload> {
  error: unknown
}

export interface TrackerSaveCoordinatorOptions<TPayload> {
  keyOf(payload: TPayload): string
  save(payload: TPayload, context: SaveAttemptContext): Promise<void>
  onStateChange?(key: string, state: TrackerSaveState): void
  onIdle?(): void
  shouldRetry?(error: unknown): boolean
  debounceMs?: number
  retryDelayMs?: number
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_RETRY_DELAY_MS = 1_000

export class TrackerSaveCoordinator<TPayload> {
  private readonly keyOf: TrackerSaveCoordinatorOptions<TPayload>["keyOf"]
  private readonly savePayload: TrackerSaveCoordinatorOptions<TPayload>["save"]
  private readonly onStateChange?: TrackerSaveCoordinatorOptions<TPayload>["onStateChange"]
  private readonly onIdle?: TrackerSaveCoordinatorOptions<TPayload>["onIdle"]
  private readonly shouldRetry: NonNullable<TrackerSaveCoordinatorOptions<TPayload>["shouldRetry"]>
  private readonly debounceMs: number
  private readonly retryDelayMs: number
  private readonly setTimer: NonNullable<TrackerSaveCoordinatorOptions<TPayload>["setTimer"]>
  private readonly clearTimer: NonNullable<TrackerSaveCoordinatorOptions<TPayload>["clearTimer"]>

  private readonly revisions = new Map<string, number>()
  private readonly states = new Map<string, TrackerSaveState>()
  private readonly pending = new Map<string, PendingEntry<TPayload>>()
  private readonly failed = new Map<string, FailedEntry<TPayload>>()
  private readonly dispatchedKeys = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: PendingEntry<TPayload> | null = null
  private readyToDrain = false
  private disposed = false
  private wasBusy = false

  constructor(options: TrackerSaveCoordinatorOptions<TPayload>) {
    this.keyOf = options.keyOf
    this.savePayload = options.save
    this.onStateChange = options.onStateChange
    this.onIdle = options.onIdle
    this.shouldRetry = options.shouldRetry ?? (() => false)
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  queueSave(payload: TPayload): number {
    this.assertActive()
    const key = this.keyOf(payload)
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    this.failed.delete(key)
    this.pending.set(key, { key, payload, revision })
    this.emitState(key, { revision, status: "pending", error: null })
    this.markBusy()
    this.scheduleDrain()
    return revision
  }

  supersede(key: string): number {
    this.assertActive()
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    this.pending.delete(key)
    this.failed.delete(key)
    this.emitState(key, { revision, status: "idle", error: null })
    if (this.pending.size === 0 && this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    if (!this.hasActiveWork()) this.finishIdleCycle()
    return revision
  }

  retry(key: string): boolean {
    this.assertActive()
    const failed = this.failed.get(key)
    if (!failed) return false
    this.failed.delete(key)
    this.pending.set(key, {
      key,
      payload: failed.payload,
      revision: failed.revision,
    })
    this.emitState(key, {
      revision: failed.revision,
      status: "pending",
      error: null,
    })
    this.markBusy()
    this.scheduleDrain()
    return true
  }

  getState(key: string): TrackerSaveState {
    return this.states.get(key) ?? { revision: 0, status: "idle", error: null }
  }

  hasActiveWork(key?: string): boolean {
    if (key) {
      return this.pending.has(key) || this.inFlight?.key === key
    }
    return this.pending.size > 0 || this.inFlight !== null
  }

  hasDispatched(key: string): boolean {
    return this.dispatchedKeys.has(key)
  }

  flush(): Promise<void> {
    this.assertActive()
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.readyToDrain = true
    void this.drain()
    if (!this.hasActiveWork()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.failed.clear()
    this.resolveIdleWaiters()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TrackerSaveCoordinator is disposed")
  }

  private markBusy(): void {
    this.wasBusy = true
  }

  private scheduleDrain(): void {
    if (this.timer) this.clearTimer(this.timer)
    this.readyToDrain = false
    this.timer = this.setTimer(() => {
      this.timer = null
      this.readyToDrain = true
      void this.drain()
    }, this.debounceMs)
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.inFlight || !this.readyToDrain) return
    const next = this.pending.values().next().value as PendingEntry<TPayload> | undefined
    if (!next) {
      this.finishIdleCycle()
      return
    }

    this.pending.delete(next.key)
    this.inFlight = next
    this.dispatchedKeys.add(next.key)
    this.emitIfCurrent(next, "saving", null)

    let error: unknown = null
    try {
      await this.savePayload(next.payload, { revision: next.revision, attempt: 1 })
    } catch (firstError) {
      error = firstError
      if (this.shouldRetry(firstError) && this.isCurrent(next)) {
        await this.delay(this.retryDelayMs)
        if (!this.disposed && this.isCurrent(next)) {
          try {
            await this.savePayload(next.payload, { revision: next.revision, attempt: 2 })
            error = null
          } catch (retryError) {
            error = retryError
          }
        }
      }
    }

    this.inFlight = null
    if (error === null) {
      this.failed.delete(next.key)
      this.emitIfCurrent(next, "saved", null)
    } else if (this.isCurrent(next)) {
      this.failed.set(next.key, { ...next, error })
      this.emitState(next.key, {
        revision: next.revision,
        status: "error",
        error,
      })
    }

    if (this.pending.size > 0) {
      if (!this.timer) this.readyToDrain = true
      void this.drain()
      return
    }
    this.finishIdleCycle()
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(resolve, delayMs)
    })
  }

  private isCurrent(entry: PendingEntry<TPayload>): boolean {
    return this.revisions.get(entry.key) === entry.revision
  }

  private emitIfCurrent(
    entry: PendingEntry<TPayload>,
    status: TrackerSaveStatus,
    error: unknown | null,
  ): void {
    if (!this.isCurrent(entry)) return
    this.emitState(entry.key, { revision: entry.revision, status, error })
  }

  private emitState(key: string, state: TrackerSaveState): void {
    this.states.set(key, state)
    this.onStateChange?.(key, state)
  }

  private finishIdleCycle(): void {
    if (this.hasActiveWork() || this.timer) return
    this.readyToDrain = false
    this.resolveIdleWaiters()
    if (!this.wasBusy) return
    this.wasBusy = false
    this.onIdle?.()
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
