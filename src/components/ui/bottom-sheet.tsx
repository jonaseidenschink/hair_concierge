"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

// --- Context ---

interface BottomSheetContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
  titleId: string
}

const BottomSheetContext = React.createContext<BottomSheetContextValue>({
  open: false,
  onOpenChange: () => {},
  titleId: "",
})

function getTabbableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    const style = window.getComputedStyle(element)
    return (
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest('[aria-disabled="true"]') &&
      !element.closest("[inert]") &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    )
  })
}

// --- BottomSheet ---

interface BottomSheetProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

function BottomSheet({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  children,
}: BottomSheetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const titleId = React.useId()

  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen
  const onOpenChange = controlledOnOpenChange || setUncontrolledOpen

  return (
    <BottomSheetContext.Provider value={{ open, onOpenChange, titleId }}>
      {children}
    </BottomSheetContext.Provider>
  )
}

// --- BottomSheetContent ---

interface BottomSheetContentProps extends React.HTMLAttributes<HTMLDivElement> {
  rootClassName?: string
  footer?: React.ReactNode
}

const BottomSheetContent = React.forwardRef<HTMLDivElement, BottomSheetContentProps>(
  ({ className, rootClassName, footer, children, style, ...props }, ref) => {
    const { open, onOpenChange, titleId } = React.useContext(BottomSheetContext)
    const [mounted, setMounted] = React.useState(false)
    const [visible, setVisible] = React.useState(false)
    const [closing, setClosing] = React.useState(false)

    // Drag state
    const [dragY, setDragY] = React.useState(0)
    const [dragging, setDragging] = React.useState(false)
    const dragYRef = React.useRef(0)
    const draggingRef = React.useRef(false)
    const dragStartY = React.useRef(0)
    // Drag candidate before the movement threshold is reached. We must NOT
    // setPointerCapture on plain taps: with capture active the browser
    // dispatches the subsequent `click` to the capturing panel instead of the
    // child button, which silently kills every button/link inside the sheet.
    const pendingDrag = React.useRef<{ pointerId: number; startY: number } | null>(null)
    const contentRef = React.useRef<HTMLDivElement>(null)
    const panelRef = React.useRef<HTMLDivElement>(null)
    const closeButtonRef = React.useRef<HTMLButtonElement>(null)
    const previousFocusRef = React.useRef<HTMLElement | null>(null)

    // Merge forwarded ref with internal panelRef
    const mergedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        panelRef.current = node
        if (typeof ref === "function") ref(node)
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
      },
      [ref],
    )

    React.useEffect(() => {
      setMounted(true)
    }, [])

    // Open → visible, close → closing → animationend → hidden
    React.useEffect(() => {
      if (open) {
        setVisible(true)
        setClosing(false)
      } else if (visible) {
        setClosing(true)
      }
    }, [open, visible])

    const finishClose = React.useCallback(() => {
      setVisible(false)
      setClosing(false)
      setDragY(0)
      dragYRef.current = 0
      draggingRef.current = false
    }, [])

    const handleAnimationEnd = React.useCallback(
      (event: React.AnimationEvent) => {
        if (event.currentTarget === event.target && closing) finishClose()
      },
      [closing, finishClose],
    )

    React.useEffect(() => {
      if (!closing || !panelRef.current) return
      const durations = getComputedStyle(panelRef.current)
        .animationDuration.split(",")
        .map((value) => value.trim())
        .map((value) =>
          value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000,
        )
        .filter(Number.isFinite)
      const timeout = window.setTimeout(finishClose, Math.max(0, ...durations) + 50)
      return () => window.clearTimeout(timeout)
    }, [closing, finishClose])

    // Focus management: auto-focus close button on open, restore focus on close
    React.useEffect(() => {
      if (visible && !closing) {
        previousFocusRef.current = document.activeElement as HTMLElement
        // Small delay to let the portal mount
        requestAnimationFrame(() => {
          closeButtonRef.current?.focus()
        })
      } else if (!visible && previousFocusRef.current) {
        previousFocusRef.current.focus()
        previousFocusRef.current = null
      }
    }, [visible, closing])

    // Focus trap: keep Tab/Shift+Tab within the panel
    React.useEffect(() => {
      if (!visible || closing) return

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Tab") return
        const panel = panelRef.current
        if (!panel) return

        const focusable = getTabbableElements(panel)
        if (focusable.length === 0) return

        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }

      document.addEventListener("keydown", handleKeyDown)
      return () => document.removeEventListener("keydown", handleKeyDown)
    }, [visible, closing])

    // Body overflow lock
    React.useEffect(() => {
      if (visible) {
        document.body.style.overflow = "hidden"
      } else {
        document.body.style.overflow = ""
      }
      return () => {
        document.body.style.overflow = ""
      }
    }, [visible])

    // Escape key
    React.useEffect(() => {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape") onOpenChange(false)
      }
      if (visible) {
        document.addEventListener("keydown", handleEscape)
      }
      return () => document.removeEventListener("keydown", handleEscape)
    }, [visible, onOpenChange])

    // Drag handlers
    const handlePointerDown = React.useCallback((e: React.PointerEvent) => {
      const target = e.target as HTMLElement
      // Elements with their own pointer interactions (e.g. sliders) manage
      // their own capture — never hijack their gestures.
      if (target.closest('[role="slider"]')) return
      // Only start drag from the handle area or when scrolled to top
      const isHandle = target.closest("[data-bottom-sheet-handle]")
      const scrollContainer = contentRef.current
      const isScrolledToTop = !scrollContainer || scrollContainer.scrollTop <= 0

      if (!isHandle && !isScrolledToTop) return

      // Record a drag candidate only — capture happens after real movement.
      pendingDrag.current = { pointerId: e.pointerId, startY: e.clientY }
    }, [])

    const handlePointerMove = React.useCallback(
      (e: React.PointerEvent) => {
        const pending = pendingDrag.current
        if (!dragging && pending && e.pointerId === pending.pointerId) {
          const delta = e.clientY - pending.startY
          if (delta > 12) {
            // Real downward drag: take over the gesture now.
            dragStartY.current = pending.startY
            pendingDrag.current = null
            draggingRef.current = true
            setDragging(true)
            panelRef.current?.setPointerCapture(e.pointerId)
            dragYRef.current = Math.max(0, delta)
            setDragY(dragYRef.current)
          } else if (delta < -12) {
            // Upward movement is not a dismiss gesture.
            pendingDrag.current = null
          }
          return
        }
        if (!dragging) return
        const delta = e.clientY - dragStartY.current
        // Only allow dragging downward
        dragYRef.current = Math.max(0, delta)
        setDragY(dragYRef.current)
      },
      [dragging],
    )

    const handlePointerUp = React.useCallback(
      (event: React.PointerEvent) => {
        const pending = pendingDrag.current
        pendingDrag.current = null
        if (!draggingRef.current) {
          if (pending && event.clientY - pending.startY > 80) onOpenChange(false)
          return
        }
        draggingRef.current = false
        setDragging(false)
        if (dragYRef.current > 80) {
          onOpenChange(false)
          // Don't reset dragY — handleAnimationEnd cleans it up after exit animation
        } else {
          dragYRef.current = 0
          setDragY(0)
        }
      },
      [onOpenChange],
    )

    const handlePointerCancel = React.useCallback((event: React.PointerEvent) => {
      const pending = pendingDrag.current
      if (!draggingRef.current && (!pending || pending.pointerId !== event.pointerId)) {
        return
      }
      pendingDrag.current = null
      draggingRef.current = false
      dragYRef.current = 0
      setDragging(false)
      setDragY(0)
    }, [])

    if (!mounted || !visible) return null

    return createPortal(
      <div className={cn("bottom-sheet-root fixed inset-0 z-50", rootClassName)}>
        {/* Backdrop */}
        <div
          className={cn(
            "bottom-sheet-backdrop fixed inset-0 bg-black/20",
            dragging && "pointer-events-none",
          )}
          data-state={closing ? "closed" : "open"}
          onClick={() => onOpenChange(false)}
        />
        {/* Panel */}
        <div
          ref={mergedRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-bottom-sheet-panel
          data-dragging={dragging ? "true" : "false"}
          data-state={closing ? "closed" : "open"}
          className={cn(
            "bottom-sheet-panel fixed inset-x-0 bottom-0 z-50 flex max-h-[60vh] touch-pan-y flex-col rounded-t-2xl bg-background shadow-[0_-4px_32px_rgba(0,0,0,0.3)]",
            className,
          )}
          style={{
            ...style,
            transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          }}
          {...props}
          onAnimationEnd={handleAnimationEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
        >
          {/* Drag handle */}
          <div
            className="flex shrink-0 touch-none items-center justify-center pb-1 pt-3"
            data-bottom-sheet-handle
          >
            <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          </div>

          {/* Close button */}
          <button
            ref={closeButtonRef}
            type="button"
            className="absolute right-3 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-md bg-background/95 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Schließen</span>
          </button>

          {/* Scrollable content */}
          <div ref={contentRef} className="overflow-y-auto px-6 pb-6">
            {children}
          </div>
          {footer ? (
            <div className="shrink-0 border-t bg-background px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
              {footer}
            </div>
          ) : null}
        </div>
      </div>,
      document.body,
    )
  },
)
BottomSheetContent.displayName = "BottomSheetContent"

// --- BottomSheetHeader ---

function BottomSheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start gap-4", className)} {...props} />
}

// --- BottomSheetTitle ---

function BottomSheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const { titleId } = React.useContext(BottomSheetContext)

  return (
    <h2
      id={titleId}
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  )
}

// --- BottomSheetDescription ---

function BottomSheetDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

export {
  BottomSheet,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
}
