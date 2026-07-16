"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useQuizStore } from "@/lib/quiz/store"

/**
 * Final quiz step (14 "auth_transition"). In the new paid-funnel model,
 * user accounts are created exclusively after checkout. This legacy step
 * forwards a completed lead to the personalized result offer.
 */
export function QuizWelcome() {
  const router = useRouter()
  const leadId = useQuizStore((s) => s.leadId)

  useEffect(() => {
    const target = leadId ? `/result/${encodeURIComponent(leadId)}?focus=unlock-plan` : "/quiz"
    router.replace(target)
  }, [leadId, router])

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-fade-in-up">
      <p className="text-sm text-muted-foreground">Einen Moment …</p>
    </div>
  )
}
