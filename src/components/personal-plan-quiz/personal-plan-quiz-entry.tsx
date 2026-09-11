"use client"

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import {
  getPersonalPlanContinuationFailureCount,
  RecoveringLazyPersonalPlanQuiz,
  retryPersonalPlanContinuationNow,
  ServerResumeLazyPersonalPlanQuiz,
  subscribeToPersonalPlanContinuationFailures,
} from "./personal-plan-quiz-continuation"
import {
  PersonalPlanQuizFrame,
  PersonalPlanQuizLegalLine,
  PersonalPlanQuizTextureQuestion,
} from "./personal-plan-quiz-first-screen"
import type { FreshPersonalPlanQuizEntry } from "./progressive-entry-contract"
import {
  consumeProgressiveEntryRecovery,
  persistProgressiveEntryRecovery,
} from "./progressive-entry-recovery"
import type { PersonalPlanTexture } from "./texture-question"
import { scheduleAfterFirstPaint } from "@/lib/analytics/runtime/post-paint"
import { trackAppEvent } from "@/lib/analytics/track-app-event"
import { createFunnelEventId, recordBrowserFunnelMilestone } from "@/lib/funnel/client"
import { loadPersonalPlanQuizDraft } from "@/lib/personal-plan-quiz/draft"
import type { PersonalPlanQuizResumeBootstrap } from "@/lib/personal-plan-quiz/types"

import { useModeratorQuiz } from "./moderator-quiz-context"
import {
  scopeQuizDraftStorage,
  clearUnscopedQuizDraftStorage,
} from "@/lib/personal-plan-quiz/draft-scope"

const DISABLED_RESUME: PersonalPlanQuizResumeBootstrap = { enabled: false, snapshot: null }
const WAITING_STATUS_DELAY_MS = 800
const DOCUMENT_RECOVERY_DELAY_MS = 1_000

function getLocalDraft(scope?: string) {
  try {
    return loadPersonalPlanQuizDraft(scopeQuizDraftStorage(window.localStorage, scope))
  } catch {
    return null
  }
}

export function PersonalPlanQuizEntry({
  fieldTest = false,
  freemiumScannerFirst = false,
  resume = DISABLED_RESUME,
}: {
  fieldTest?: boolean
  freemiumScannerFirst?: boolean
  resume?: PersonalPlanQuizResumeBootstrap
}) {
  const moderator = useModeratorQuiz()
  const draftScope = moderator?.scope
  const serverResume = Boolean(resume.enabled && resume.snapshot)
  const [showQuiz, setShowQuiz] = useState(serverResume)
  const [clientReady, setClientReady] = useState(false)
  const [selected, setSelected] = useState<PersonalPlanTexture>()
  const [selectedAt, setSelectedAt] = useState<number>()
  const [recoveryVisible, setRecoveryVisible] = useState(false)
  const [shellOwnsTextureView, setShellOwnsTextureView] = useState(false)
  const [quizStarted, setQuizStarted] = useState(false)
  const [documentRecoveryAttempt, setDocumentRecoveryAttempt] = useState(0)
  const [restoringLocalDraft, setRestoringLocalDraft] = useState(false)
  const [recoverySignal, setRecoverySignal] = useState(0)
  const shellOwnsTextureViewRef = useRef(false)
  const quizStartedRef = useRef(false)

  const failureCount = useSyncExternalStore(
    subscribeToPersonalPlanContinuationFailures,
    getPersonalPlanContinuationFailureCount,
    getPersonalPlanContinuationFailureCount,
  )

  const claimFreshTextureView = useCallback(() => {
    if (shellOwnsTextureViewRef.current) return
    shellOwnsTextureViewRef.current = true
    setShellOwnsTextureView(true)
    trackAppEvent("personal_plan_quiz_screen_viewed", {
      quizVersion: "v2",
      screenId: "texture",
      sectionId: "hair_profile",
      testKind: fieldTest ? "field_test" : null,
    })
  }, [fieldTest])

  useEffect(() => {
    let disposed = false
    const draftFrame = window.requestAnimationFrame(() => {
      if (disposed) return
      if (draftScope) {
        try {
          clearUnscopedQuizDraftStorage(window.localStorage)
          clearUnscopedQuizDraftStorage(window.sessionStorage)
          consumeProgressiveEntryRecovery(window.sessionStorage)
        } catch {
          /* Scoped storage remains the only restore source. */
        }
      }
      const progressiveRecovery = consumeProgressiveEntryRecovery(
        scopeQuizDraftStorage(window.sessionStorage, draftScope),
      )
      if (serverResume) {
        setClientReady(true)
        return
      }
      if (progressiveRecovery?.kind === "selected") {
        shellOwnsTextureViewRef.current = true
        quizStartedRef.current = progressiveRecovery.quizStarted
        setShellOwnsTextureView(true)
        setQuizStarted(progressiveRecovery.quizStarted)
        setSelected(progressiveRecovery.texture)
        setSelectedAt(progressiveRecovery.selectedAt)
        setDocumentRecoveryAttempt(progressiveRecovery.attempt)
        setShowQuiz(true)
      } else if (progressiveRecovery?.kind === "local_draft" && getLocalDraft(draftScope)) {
        setDocumentRecoveryAttempt(progressiveRecovery.attempt)
        setRestoringLocalDraft(true)
        setShowQuiz(true)
      } else if (getLocalDraft(draftScope)) {
        setRestoringLocalDraft(true)
        setShowQuiz(true)
      } else {
        claimFreshTextureView()
      }
      setClientReady(true)
    })
    const cancelPostPaint = serverResume
      ? () => {}
      : scheduleAfterFirstPaint(() => {
          if (!disposed) setShowQuiz(true)
        })
    return () => {
      disposed = true
      window.cancelAnimationFrame(draftFrame)
      cancelPostPaint()
    }
  }, [claimFreshTextureView, serverResume, draftScope])

  useEffect(() => {
    const retry = () => {
      retryPersonalPlanContinuationNow()
      setRecoverySignal((signal) => signal + 1)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") retry()
    }
    window.addEventListener("online", retry)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("online", retry)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (
      (!selected && !restoringLocalDraft) ||
      failureCount === 0 ||
      documentRecoveryAttempt > 0 ||
      !navigator.onLine ||
      document.hidden
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      if (!navigator.onLine || document.hidden) return
      persistProgressiveEntryRecovery(
        scopeQuizDraftStorage(window.sessionStorage, draftScope),
        selected
          ? {
              attempt: 1,
              kind: "selected",
              quizStarted: quizStartedRef.current,
              selectedAt: selectedAt ?? Date.now(),
              texture: selected,
            }
          : { attempt: 1, kind: "local_draft" },
      )
      window.location.reload()
    }, DOCUMENT_RECOVERY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [
    documentRecoveryAttempt,
    draftScope,
    failureCount,
    recoverySignal,
    restoringLocalDraft,
    selected,
    selectedAt,
  ])

  useEffect(() => {
    if ((!selected && !restoringLocalDraft) || failureCount === 0) {
      return
    }
    const delayMs = Math.max(0, WAITING_STATUS_DELAY_MS - (Date.now() - (selectedAt ?? Date.now())))
    const timer = window.setTimeout(() => setRecoveryVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [failureCount, restoringLocalDraft, selected, selectedAt])

  function selectTexture(texture: PersonalPlanTexture) {
    if (getLocalDraft(draftScope)) {
      setRestoringLocalDraft(true)
      setShowQuiz(true)
      retryPersonalPlanContinuationNow()
      return
    }
    claimFreshTextureView()
    const selectionTime = Date.now()
    setRecoveryVisible(false)
    setSelected(texture)
    setSelectedAt(selectionTime)
    if (!quizStartedRef.current) {
      quizStartedRef.current = true
      setQuizStarted(true)
      const funnelEventId = createFunnelEventId()
      const funnel = recordBrowserFunnelMilestone("quiz_started", undefined, funnelEventId)
      trackAppEvent("quiz_started", {
        stepName: "personal_plan_texture",
        stepNumber: 1,
        funnelEventId,
        funnelPackageKey: funnel.funnelPackageKey,
        funnelSessionId: funnel.funnelSessionId,
        testKind: fieldTest ? "field_test" : null,
      })
    }
    setShowQuiz(true)
    retryPersonalPlanContinuationNow()
  }

  const shell = (
    <>
      <PersonalPlanQuizFrame
        canGoBack={false}
        clientReady={clientReady}
        currentSectionIndex={0}
        fieldTest={fieldTest}
        onBack={() => {}}
        progress={4}
        settledSectionIndices={new Set()}
      >
        <PersonalPlanQuizTextureQuestion
          expectationLine={freemiumScannerFirst}
          onSelect={selectTexture}
          recoveryVisible={Boolean(
            (selected || restoringLocalDraft) && failureCount > 0 && recoveryVisible,
          )}
          selected={selected}
        />
      </PersonalPlanQuizFrame>
      <PersonalPlanQuizLegalLine />
    </>
  )

  if (!showQuiz) return shell

  const entry: FreshPersonalPlanQuizEntry | undefined = shellOwnsTextureView
    ? {
        suppressInitialTextureScreenView: true,
        quizStarted,
        ...(selected ? { texture: selected } : {}),
        ...(selectedAt !== undefined ? { selectedAt } : {}),
      }
    : undefined

  return (
    <Suspense fallback={serverResume ? null : shell}>
      {serverResume ? (
        <ServerResumeLazyPersonalPlanQuiz
          fieldTest={fieldTest}
          freemiumScannerFirst={freemiumScannerFirst}
          resume={resume}
        />
      ) : (
        <RecoveringLazyPersonalPlanQuiz
          entry={entry}
          fieldTest={fieldTest}
          freemiumScannerFirst={freemiumScannerFirst}
          resume={resume}
        />
      )}
    </Suspense>
  )
}
