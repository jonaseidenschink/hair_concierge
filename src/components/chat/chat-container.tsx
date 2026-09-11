"use client"

import { useAuth } from "@/providers/auth-provider"
import { useChat } from "@/hooks/use-chat"
import { useHairProfile } from "@/hooks/use-hair-profile"
import { generateSuggestedPrompts } from "@/lib/suggested-prompts"
import { ChatInput } from "./chat-input"
import { ChatKeepsakeComposer } from "./chat-keepsake-composer"
import { ChatMessage } from "./chat-message"
import { PremiumSheet } from "@/components/premium-sheet/premium-sheet"
import type { PremiumSheetContext } from "@/lib/premium-sheet/context"
import { ChatLoadingIndicator } from "./chat-loading-indicator"
import { ProductDetailDrawer } from "./product-detail-drawer"
import { ConversationSidebar } from "./conversation-sidebar"
import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { format, isToday, isYesterday } from "date-fns"
import { de } from "date-fns/locale"
import { ArrowDown, Menu } from "lucide-react"
import { CombIcon } from "@/components/ui/comb-icon"
import { Icon } from "@/components/ui/icon"
import type { Product } from "@/lib/types"
import { clearRoutineTriggerSeed, readRoutineTriggerSeed } from "@/lib/routines/chat-triggers"
import { useRouter } from "next/navigation"
import {
  buildProductIntakeOfferStateByMessageId,
  buildProductLookupClarificationStateByMessageId,
} from "@/lib/chat/product-lookup-selection-ui"

const JUMP_TO_LATEST_THRESHOLD_PX = 80
const USER_OVERRIDE_DISTANCE_PX = 200
const ASSISTANT_TOP_PADDING_PX = 16

type ChatContainerProps = {
  conversationId?: string | null
  /**
   * T17 keepsake mode: a LAPSED owner reading their OWN conversation history after their
   * access ended. The history itself stays readable — middleware admits `GET /api/chat`
   * and `GET /api/chat/[id]` for them (method-scoped carve-out, see
   * `FREEMIUM_KEEPSAKE_READ_ROUTE_PREFIXES` in `lib/supabase/middleware.ts`) — while every
   * write this component can start is replaced by the Premium sheet: the composer, the
   * starter prompts, "Neue Unterhaltung", conversation delete, message feedback, product
   * selection, product-intake submission and the drawer's routine action. Their endpoints
   * all still answer 403 for this user; locking them here is so the user meets a gate
   * instead of an error.
   *
   * Defaults to `false`: premium and flag-off render byte-identically to today.
   */
  keepsake?: boolean
}

/**
 * T17: the gate a lapsed owner opens from their own chat. Same `{feature, source}` pair
 * the T12 „Beispiel" chat uses (`GATED_EXAMPLE_COPY.chat`), so the sheet orders its
 * benefits identically from either surface.
 */
const KEEPSAKE_CHAT_GATE = { feature: "chat", source: "gated:chat" } as const

type RoutineProductMembership = {
  category: string | null
  usageId: string | null
}

type RoutineMembershipCard = {
  category?: string | null
  usageRow?: { id?: string | null } | null
  product?: { id?: string | null } | null
}

export function ChatContainer({
  conversationId: initialConversationId = null,
  keepsake = false,
}: ChatContainerProps) {
  const router = useRouter()
  const { profile } = useAuth()
  const {
    messages,
    isStreaming,
    conversations,
    currentConversationId,
    sendMessage,
    selectProductCandidate,
    submitFeedback,
    loadConversation,
    loadConversations,
    deleteConversation,
    startNewConversation,
    applyProductIntakeSubmission,
  } = useChat()

  const { hairProfile } = useHairProfile()
  const suggestedPrompts = useMemo(() => generateSuggestedPrompts(hairProfile), [hairProfile])
  const productLookupClarificationStateByMessageId = useMemo(
    () => buildProductLookupClarificationStateByMessageId(messages),
    [messages],
  )
  const productIntakeOfferStateByMessageId = useMemo(
    () => buildProductIntakeOfferStateByMessageId(messages),
    [messages],
  )

  const [sidebarState, setSidebarState] = useState<"closed" | "open" | "closing">("closed")
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const sidebarCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [drawerProduct, setDrawerProduct] = useState<Product | null>(null)
  const [routineProductMembership, setRoutineProductMembership] = useState<
    Map<string, RoutineProductMembership>
  >(() => new Map())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const messageTopRefs = useRef(new Map<string, HTMLDivElement>())
  const userInitiatedTurnRef = useRef(false)
  const userOverrideRef = useRef(false)
  const assistantTurnAnchoredRef = useRef(false)
  const anchoredAssistantIdRef = useRef<string | null>(null)
  const programmaticScrollRef = useRef(false)
  const assistantContentByIdRef = useRef(new Map<string, string>())
  const wasStreamingRef = useRef(isStreaming)
  const consumedRoutineSeedConversationRef = useRef<string | null>(null)
  const suppressInitialConversationReloadRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  // T17 keepsake gate. Same opener shape as `GatedPreview`'s and T15's Profil opener.
  // Never rendered outside keepsake mode.
  const [premiumSheetOpen, setPremiumSheetOpen] = useState(false)
  const [premiumSheetContext, setPremiumSheetContext] = useState<PremiumSheetContext | null>(null)
  const openPremiumSheet = useCallback((context: PremiumSheetContext) => {
    setPremiumSheetContext(context)
    setPremiumSheetOpen(true)
  }, [])
  const openKeepsakeChatGate = useCallback(
    () => openPremiumSheet(KEEPSAKE_CHAT_GATE),
    [openPremiumSheet],
  )

  // Track IDs of messages appended during this session (not from history loads).
  // Uses the "update state during render" pattern recommended by React for
  // derived state that depends on previous values.
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(() => new Set())
  const [prevMessageCount, setPrevMessageCount] = useState(0)
  const [prevConversationId, setPrevConversationId] = useState(currentConversationId)

  // Reset when conversation changes (update-during-render pattern)
  if (prevConversationId !== currentConversationId) {
    setNewMessageIds(new Set())
    setPrevMessageCount(0)
    setPrevConversationId(currentConversationId)
  }

  // Detect newly appended messages (update-during-render pattern)
  const currentCount = messages.length
  if (currentCount > prevMessageCount && prevMessageCount > 0) {
    const next = new Set(newMessageIds)
    for (let i = prevMessageCount; i < currentCount; i++) {
      next.add(messages[i].id)
    }
    setNewMessageIds(next)
    setPrevMessageCount(currentCount)
  } else if (currentCount !== prevMessageCount) {
    setPrevMessageCount(currentCount)
  }

  const isEmpty = messages.length === 0

  const loadRoutineProductMembership = useCallback(async () => {
    const response = await fetch("/api/routine")
    if (!response.ok) return

    const body = (await response.json().catch(() => null)) as {
      routine?: { cards?: RoutineMembershipCard[] }
    } | null
    const cards = Array.isArray(body?.routine?.cards) ? body.routine.cards : []
    const nextMembership = new Map<string, RoutineProductMembership>()

    for (const card of cards) {
      const productId = card.product?.id?.trim()
      if (!productId) continue
      nextMembership.set(productId, {
        category: card.category ?? null,
        usageId: card.usageRow?.id ?? null,
      })
    }

    setRoutineProductMembership(nextMembership)
  }, [])

  // Clear newMessageIds after animation completes so streaming deltas don't get smooth-scroll
  useEffect(() => {
    if (newMessageIds.size > 0) {
      const timer = setTimeout(() => {
        setNewMessageIds(new Set())
      }, 400) // match fadeInUpFast duration (300ms) + buffer
      return () => clearTimeout(timer)
    }
  }, [newMessageIds])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (suppressInitialConversationReloadRef.current && currentConversationId === null) return
    if (!initialConversationId) {
      suppressInitialConversationReloadRef.current = false
      return
    }
    if (
      messages.length === 0 &&
      readRoutineTriggerSeed(initialConversationId, window.sessionStorage)
    ) {
      return
    }
    if (!initialConversationId || currentConversationId === initialConversationId) return
    loadConversation(initialConversationId)
  }, [currentConversationId, initialConversationId, loadConversation, messages.length])

  useEffect(() => {
    // Keepsake: this is the one write that does NOT go through `handleSendMessage` — it
    // dispatches a routine-trigger seed straight to `sendMessage` on mount. A lapsed
    // owner's `POST /api/chat` is denied, so it would be a guaranteed failed turn; the
    // seed is left in sessionStorage untouched for whenever they unlock chat again.
    if (keepsake) return
    const routineSeedConversationId = currentConversationId ?? initialConversationId
    if (!routineSeedConversationId || messages.length > 0 || isStreaming) return
    if (consumedRoutineSeedConversationRef.current === routineSeedConversationId) return

    const seedMessage = readRoutineTriggerSeed(routineSeedConversationId, window.sessionStorage)
    if (!seedMessage) return

    consumedRoutineSeedConversationRef.current = routineSeedConversationId
    const conversationId = routineSeedConversationId
    void sendMessage(seedMessage, { conversationId }).then(async (sent) => {
      if (sent) {
        await loadConversation(conversationId)
        clearRoutineTriggerSeed(conversationId, window.sessionStorage)
        return
      }
      consumedRoutineSeedConversationRef.current = null
    })
  }, [
    currentConversationId,
    initialConversationId,
    isStreaming,
    keepsake,
    loadConversation,
    messages.length,
    sendMessage,
  ])

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      window.requestAnimationFrame(() => {
        userInitiatedTurnRef.current = false
        userOverrideRef.current = false
      })
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  const triggerRef = useRef<HTMLElement | null>(null)

  const updateJumpToLatestVisibility = useCallback(() => {
    const container = messagesScrollRef.current
    if (!container) {
      setShowJumpToLatest(false)
      return
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    setShowJumpToLatest(distanceFromBottom > JUMP_TO_LATEST_THRESHOLD_PX)
  }, [])

  const scheduleJumpToLatestVisibilityUpdate = useCallback(() => {
    window.requestAnimationFrame(() => {
      updateJumpToLatestVisibility()
    })
  }, [updateJumpToLatestVisibility])

  const scrollContainerTo = useCallback(
    (top: number, behavior: ScrollBehavior = "auto") => {
      const container = messagesScrollRef.current
      if (!container) return

      programmaticScrollRef.current = true
      container.scrollTo({ top: Math.max(0, top), behavior })

      window.setTimeout(
        () => {
          programmaticScrollRef.current = false
          updateJumpToLatestVisibility()
        },
        behavior === "smooth" ? 450 : 0,
      )
    },
    [updateJumpToLatestVisibility],
  )

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = messagesScrollRef.current
      if (!container) return

      scrollContainerTo(container.scrollHeight, behavior)
    },
    [scrollContainerTo],
  )

  const handleJumpToLatest = useCallback(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    scrollToLatest(prefersReducedMotion ? "auto" : "smooth")
  }, [scrollToLatest])

  const latestAssistantMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant") ?? null,
    [messages],
  )

  useEffect(() => {
    const container = messagesScrollRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver(() => {
      updateJumpToLatestVisibility()
    })
    resizeObserver.observe(container)
    if (messagesContentRef.current) {
      resizeObserver.observe(messagesContentRef.current)
    }

    scheduleJumpToLatestVisibilityUpdate()

    return () => {
      resizeObserver.disconnect()
    }
  }, [isEmpty, scheduleJumpToLatestVisibilityUpdate, updateJumpToLatestVisibility])

  useEffect(() => {
    const container = messagesScrollRef.current
    if (!container) return

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight

    if (
      isStreaming &&
      userInitiatedTurnRef.current &&
      !programmaticScrollRef.current &&
      distanceFromBottom > USER_OVERRIDE_DISTANCE_PX
    ) {
      userOverrideRef.current = true
    }

    scheduleJumpToLatestVisibilityUpdate()
  }, [isStreaming, scheduleJumpToLatestVisibilityUpdate])

  useEffect(() => {
    if (messages.length === 0) {
      userInitiatedTurnRef.current = false
      userOverrideRef.current = false
      assistantTurnAnchoredRef.current = false
      anchoredAssistantIdRef.current = null
      assistantContentByIdRef.current = new Map()
      scheduleJumpToLatestVisibilityUpdate()
      return
    }

    const latestMessage = messages[messages.length - 1]
    const emptyAssistantPlaceholder = latestMessage?.role === "assistant" && !latestMessage.content
    const latestAssistantContent = latestAssistantMessage?.content ?? ""
    const latestAssistantPreviousContent = latestAssistantMessage
      ? assistantContentByIdRef.current.get(latestAssistantMessage.id)
      : undefined
    const firstContentArrived = Boolean(
      userInitiatedTurnRef.current &&
      latestAssistantMessage &&
      latestAssistantContent &&
      !assistantTurnAnchoredRef.current &&
      (latestAssistantPreviousContent === "" || latestAssistantPreviousContent === undefined),
    )

    if (!userInitiatedTurnRef.current) {
      scrollToLatest("auto")
    } else if (emptyAssistantPlaceholder) {
      scrollToLatest("auto")
    } else if (
      firstContentArrived &&
      latestAssistantMessage &&
      !userOverrideRef.current &&
      anchoredAssistantIdRef.current !== latestAssistantMessage.id
    ) {
      const assistantTop = messageTopRefs.current.get(latestAssistantMessage.id)
      if (assistantTop) {
        const container = messagesScrollRef.current
        const top = container
          ? container.scrollTop +
            (assistantTop.getBoundingClientRect().top - container.getBoundingClientRect().top) -
            ASSISTANT_TOP_PADDING_PX
          : assistantTop.offsetTop - ASSISTANT_TOP_PADDING_PX

        scrollContainerTo(top, "auto")
        assistantTurnAnchoredRef.current = true
        anchoredAssistantIdRef.current = latestAssistantMessage.id
      }
    }

    const nextContentById = new Map<string, string>()
    for (const message of messages) {
      if (message.role === "assistant") {
        nextContentById.set(message.id, message.content ?? "")
      }
    }
    assistantContentByIdRef.current = nextContentById
    scheduleJumpToLatestVisibilityUpdate()
  }, [
    latestAssistantMessage,
    messages,
    scheduleJumpToLatestVisibilityUpdate,
    scrollContainerTo,
    scrollToLatest,
  ])

  const clearSidebarCloseTimer = useCallback(() => {
    if (sidebarCloseTimerRef.current) {
      clearTimeout(sidebarCloseTimerRef.current)
      sidebarCloseTimerRef.current = null
    }
  }, [])

  const finishSidebarClose = useCallback(() => {
    clearSidebarCloseTimer()
    setSidebarState("closed")
  }, [clearSidebarCloseTimer])

  const openSidebar = useCallback(() => {
    clearSidebarCloseTimer()
    triggerRef.current = document.activeElement as HTMLElement
    setSidebarState("open")
  }, [clearSidebarCloseTimer])

  const closeSidebar = useCallback(() => {
    clearSidebarCloseTimer()

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSidebarState("closed")
      return
    }

    setSidebarState("closing")
    sidebarCloseTimerRef.current = setTimeout(() => {
      finishSidebarClose()
    }, 300)
  }, [clearSidebarCloseTimer, finishSidebarClose])

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      router.push(`/chat/${conversationId}`)
    },
    [router],
  )

  const handleStartNewConversation = useCallback(() => {
    if (keepsake) {
      openKeepsakeChatGate()
      return
    }
    suppressInitialConversationReloadRef.current = true
    startNewConversation()
    router.push("/chat")
  }, [keepsake, openKeepsakeChatGate, router, startNewConversation])

  const handleDeleteConversation = useCallback(
    (id: string) => {
      if (keepsake) {
        openKeepsakeChatGate()
        return
      }
      void deleteConversation(id)
    },
    [deleteConversation, keepsake, openKeepsakeChatGate],
  )

  useEffect(() => {
    return () => clearSidebarCloseTimer()
  }, [clearSidebarCloseTimer])

  // Focus trap + Escape for mobile sidebar
  useEffect(() => {
    if (sidebarState !== "open") return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeSidebar()
        return
      }

      if (e.key !== "Tab") return
      const panel = sidebarPanelRef.current
      if (!panel) return

      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
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
  }, [sidebarState, closeSidebar])

  // Move focus into sidebar on open, restore to trigger on close
  useEffect(() => {
    if (sidebarState === "open" && sidebarPanelRef.current) {
      const first = sidebarPanelRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      first?.focus()
    }
    if (sidebarState === "closed" && triggerRef.current) {
      triggerRef.current.focus()
      triggerRef.current = null
    }
  }, [sidebarState])

  const handleProductClick = useCallback(
    (product: Product) => {
      setDrawerProduct(product)
      setDrawerOpen(true)
      // Keepsake: the drawer offers no routine action, so its membership read (403 for a
      // lapsed user) has nothing to inform — skip it rather than fire and discard it.
      if (!keepsake) void loadRoutineProductMembership()
    },
    [keepsake, loadRoutineProductMembership],
  )

  const handleSendMessage = useCallback(
    (message: string) => {
      if (keepsake) {
        openKeepsakeChatGate()
        return
      }
      userInitiatedTurnRef.current = true
      userOverrideRef.current = false
      assistantTurnAnchoredRef.current = false
      anchoredAssistantIdRef.current = null
      void sendMessage(message)
    },
    [keepsake, openKeepsakeChatGate, sendMessage],
  )

  const handleScroll = useCallback(() => {
    const container = messagesScrollRef.current
    if (!container) return

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight

    if (
      isStreaming &&
      userInitiatedTurnRef.current &&
      !programmaticScrollRef.current &&
      distanceFromBottom > USER_OVERRIDE_DISTANCE_PX
    ) {
      userOverrideRef.current = true
    }

    setShowJumpToLatest(distanceFromBottom > JUMP_TO_LATEST_THRESHOLD_PX)
  }, [isStreaming])

  const firstName = profile?.full_name?.split(" ")[0] || null
  const hour = new Date().getHours()
  let timeGreeting = "Guten Abend"
  if (hour < 12) timeGreeting = "Guten Morgen"
  else if (hour < 18) timeGreeting = "Guten Tag"
  const greeting = firstName ? `${timeGreeting}, ${firstName}` : timeGreeting

  return (
    <div className="flex h-[calc(100dvh-3.5rem-var(--personal-plan-shell-bottom-padding,0px))] overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="hidden w-72 shrink-0 md:block">
        <ConversationSidebar
          conversations={conversations}
          currentId={currentConversationId}
          onSelect={handleSelectConversation}
          onNew={handleStartNewConversation}
          onDelete={handleDeleteConversation}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      {sidebarState !== "closed" && (
        <div
          className="fixed inset-0 z-50 flex md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Unterhaltungen"
        >
          <div
            className={`absolute inset-0 bg-black/50 ${
              sidebarState === "closing"
                ? "animate-[backdropFadeOut_0.25s_ease_both]"
                : "animate-[backdropFadeIn_0.25s_ease_both]"
            }`}
            onClick={closeSidebar}
          />
          <div
            ref={sidebarPanelRef}
            className={`relative w-72 ${
              sidebarState === "closing" ? "animate-slide-out-left" : "animate-slide-in-left"
            }`}
            onAnimationEnd={(event) => {
              if (event.currentTarget !== event.target) return
              if (sidebarState === "closing") finishSidebarClose()
            }}
          >
            <ConversationSidebar
              conversations={conversations}
              currentId={currentConversationId}
              onSelect={handleSelectConversation}
              onNew={handleStartNewConversation}
              onDelete={handleDeleteConversation}
              onClose={closeSidebar}
              isMobile
            />
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <div className="flex items-center gap-2 border-b p-3 md:hidden">
          <button
            onClick={openSidebar}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
            aria-label="Unterhaltungen öffnen"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="type-body-sm font-medium">
            {currentConversationId ? "Chat" : "Neuer Chat"}
          </span>
        </div>

        {/* Messages */}
        <div
          ref={messagesScrollRef}
          data-testid="chat-scroll-container"
          onScroll={handleScroll}
          className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          {/* Atmospheric layers */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.015]"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
              backgroundRepeat: "repeat",
              backgroundSize: "256px 256px",
            }}
          />
          <div
            className="pointer-events-none absolute left-1/2 top-0 h-[300px] w-[120%] -translate-x-1/2"
            style={{
              background:
                "radial-gradient(ellipse at 50% 0%, rgba(var(--brand-plum-rgb), 0.03), transparent 70%)",
            }}
          />

          {isEmpty ? (
            <div ref={messagesContentRef} className="relative z-[1] flex h-full flex-col px-4">
              <div className="mx-auto mt-auto flex w-full max-w-lg flex-col items-center pb-6 pt-10 md:pb-8">
                <div className="animate-scale-in mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-primary">
                  <CombIcon className="h-8 w-8 text-primary-foreground" />
                </div>
                <h2 className="animate-fade-in-up mb-2 type-h2" style={{ animationDelay: "150ms" }}>
                  {greeting}
                </h2>
                <p
                  className="animate-fade-in-up mb-6 max-w-md text-center type-body-sm text-muted-foreground"
                  style={{ animationDelay: "250ms" }}
                >
                  Frag mich nach deiner Routine, passenden Produkten oder dem nächsten sinnvollen
                  Schritt für dein Haarprofil.
                </p>
                <div
                  className="animate-fade-in-up mb-2 self-start type-label text-[11px] text-[var(--text-caption)]"
                  style={{ animationDelay: "320ms" }}
                >
                  Starterfragen
                </div>
                <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                  {suggestedPrompts.map((prompt, index) => (
                    <button
                      key={prompt.text}
                      onClick={() => handleSendMessage(prompt.text)}
                      className="animate-fade-in-up flex items-start gap-2.5 rounded-xl border px-4 py-3 text-left type-body-sm transition-all duration-200 hover:border-primary/40 hover:bg-accent hover:shadow-sm hover:-translate-y-0.5"
                      style={{ animationDelay: `${350 + index * 80}ms` }}
                    >
                      {prompt.icon && (
                        <Icon name={prompt.icon} size={18} className="shrink-0 text-primary" />
                      )}
                      {prompt.text}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div
              ref={messagesContentRef}
              className="relative z-[1] mx-auto w-full max-w-3xl space-y-4 p-4"
            >
              {messages.map((msg, idx) => {
                // Don't render empty assistant placeholder — streaming indicator handles it
                if (msg.role === "assistant" && !msg.content) return null

                // Date separator: show when date changes from previous message
                let dateSeparator: React.ReactNode = null
                if (msg.created_at) {
                  const msgDate = new Date(msg.created_at)
                  const prevMsg = idx > 0 ? messages[idx - 1] : null
                  const prevDate = prevMsg?.created_at ? new Date(prevMsg.created_at) : null
                  const dateChanged =
                    !prevDate || msgDate.toDateString() !== prevDate.toDateString()
                  if (dateChanged) {
                    let label = format(msgDate, "dd. MMM", { locale: de })
                    if (isToday(msgDate)) label = "Heute"
                    else if (isYesterday(msgDate)) label = "Gestern"
                    dateSeparator = (
                      <div className="flex items-center gap-3 py-2">
                        <div className="h-px flex-1 bg-border" />
                        <span className="type-caption text-muted-foreground">{label}</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                    )
                  }
                }

                return (
                  <div
                    key={msg.id}
                    ref={(node) => {
                      if (node) {
                        messageTopRefs.current.set(msg.id, node)
                      } else {
                        messageTopRefs.current.delete(msg.id)
                      }
                    }}
                    data-message-id={msg.id}
                  >
                    {dateSeparator}
                    <ChatMessage
                      message={msg}
                      hairProfile={hairProfile}
                      onProductClick={handleProductClick}
                      // Keepsake: every one of these is a write (`POST
                      // /api/chat/product-selection`, `POST /api/chat/feedback`, the
                      // product-intake submission). Omitted, `ChatMessage` renders the
                      // bubble without the affordance rather than with a failing one.
                      //
                      // PR5 review fix (Z4): withholding the callbacks was not enough for
                      // the two interactive CARDS inside a historical message — the
                      // clarification card called a handler that throws, and both intake
                      // forms POST `/api/product-intake` (403) on their own. `keepsake` is
                      // passed explicitly so those render as static history instead.
                      keepsake={keepsake}
                      onSelectProductCandidate={keepsake ? undefined : selectProductCandidate}
                      onFeedback={keepsake ? undefined : submitFeedback}
                      isNew={newMessageIds.has(msg.id)}
                      isStreamingMessage={
                        isStreaming && idx === messages.length - 1 && msg.role === "assistant"
                      }
                      productLookupClarificationState={productLookupClarificationStateByMessageId.get(
                        msg.id,
                      )}
                      productIntakeOfferState={productIntakeOfferStateByMessageId.get(msg.id)}
                      onProductIntakeSubmitted={keepsake ? undefined : applyProductIntakeSubmission}
                    />
                  </div>
                )
              })}

              {/* Streaming indicator */}
              {isStreaming &&
                messages[messages.length - 1]?.role === "assistant" &&
                !messages[messages.length - 1]?.content && <ChatLoadingIndicator />}

              <div />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="relative">
          <button
            type="button"
            data-testid="chat-jump-to-latest"
            onClick={handleJumpToLatest}
            aria-label="Zum Ende der Antwort springen"
            aria-hidden={!showJumpToLatest}
            tabIndex={showJumpToLatest ? 0 : -1}
            className={`absolute left-1/2 -top-14 z-10 flex min-h-11 min-w-11 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-foreground shadow-lg transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              showJumpToLatest
                ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-2 scale-95 opacity-0"
            }`}
          >
            <ArrowDown className="h-5 w-5" aria-hidden="true" />
          </button>
          {keepsake ? (
            <ChatKeepsakeComposer onUnlock={openKeepsakeChatGate} />
          ) : (
            <ChatInput onSend={handleSendMessage} disabled={isStreaming} />
          )}
        </div>
      </div>

      {/* Product Detail Drawer */}
      <ProductDetailDrawer
        product={drawerProduct}
        hairProfile={hairProfile}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        routineAction={
          drawerProduct && !keepsake
            ? {
                category: drawerProduct.category,
                productId: drawerProduct.id,
                existingUsageId: routineProductMembership.get(drawerProduct.id)?.usageId ?? null,
                alreadyInRoutine: routineProductMembership.has(drawerProduct.id),
                onChanged: loadRoutineProductMembership,
              }
            : undefined
        }
      />

      {keepsake ? (
        <PremiumSheet
          open={premiumSheetOpen}
          context={premiumSheetContext}
          onClose={() => {
            setPremiumSheetOpen(false)
            setPremiumSheetContext(null)
          }}
          // No `onUnlocked` copy to flip: keepsake mode is a SERVER prop on this page, so
          // the sheet's own `router.refresh()` after a verified purchase re-resolves it.
          onRequestOpen={(context) => openPremiumSheet(context ?? KEEPSAKE_CHAT_GATE)}
        />
      ) : null}
    </div>
  )
}
