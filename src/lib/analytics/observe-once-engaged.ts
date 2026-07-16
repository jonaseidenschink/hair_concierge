type ObserverConstructor = new (
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) => Pick<IntersectionObserver, "disconnect" | "observe">

type VisibilityDocument = Pick<
  Document,
  "addEventListener" | "removeEventListener" | "visibilityState"
>

type TimerHandle = ReturnType<typeof setTimeout>

export function observeOnceEngaged(
  element: Element,
  onEngaged: () => void,
  {
    documentTarget = typeof document === "undefined" ? undefined : document,
    dwellMs = 750,
    Observer = globalThis.IntersectionObserver,
    threshold = 0.25,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }: {
    documentTarget?: VisibilityDocument
    dwellMs?: number
    Observer?: ObserverConstructor
    threshold?: number
    setTimer?: typeof setTimeout
    clearTimer?: typeof clearTimeout
  } = {},
): () => void {
  if (!Observer || !documentTarget) return () => undefined

  let engaged = false
  let sufficientlyVisible = false
  let timer: TimerHandle | null = null

  const cancelTimer = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const schedule = () => {
    if (
      engaged ||
      timer !== null ||
      !sufficientlyVisible ||
      documentTarget.visibilityState !== "visible"
    ) {
      return
    }

    timer = setTimer(() => {
      timer = null
      if (engaged || !sufficientlyVisible || documentTarget.visibilityState !== "visible") {
        return
      }
      engaged = true
      onEngaged()
      observer.disconnect()
      documentTarget.removeEventListener("visibilitychange", handleVisibilityChange)
    }, dwellMs)
  }

  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState !== "visible") {
      cancelTimer()
      return
    }
    schedule()
  }

  const observer = new Observer(
    (entries) => {
      const entry = entries.find((candidate) => candidate.target === element) ?? entries[0]
      sufficientlyVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= threshold)
      if (!sufficientlyVisible) cancelTimer()
      else schedule()
    },
    { threshold },
  )

  documentTarget.addEventListener("visibilitychange", handleVisibilityChange)
  observer.observe(element)

  return () => {
    cancelTimer()
    observer.disconnect()
    documentTarget.removeEventListener("visibilitychange", handleVisibilityChange)
  }
}
