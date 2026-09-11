import { PersonalPlanQuizEntry } from "@/components/personal-plan-quiz/personal-plan-quiz-entry"
import { ModeratorQuizProvider } from "@/components/personal-plan-quiz/moderator-quiz-context"
import type { FunnelLandingVariantProps } from "@/funnels/types"

export default function FunnelPersonalPlanQuizLandingVariant({
  personalPlanFieldTest = false,
  personalPlanQuizResume,
  moderatorQuiz = null,
  freemiumScannerFirst = false,
}: FunnelLandingVariantProps) {
  return (
    <ModeratorQuizProvider value={moderatorQuiz}>
      <PersonalPlanQuizEntry
        key={moderatorQuiz?.scope}
        fieldTest={personalPlanFieldTest}
        freemiumScannerFirst={freemiumScannerFirst}
        resume={personalPlanQuizResume}
      />
    </ModeratorQuizProvider>
  )
}
