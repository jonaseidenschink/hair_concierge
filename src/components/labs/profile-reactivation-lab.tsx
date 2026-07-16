import { MembershipReactivationPage } from "@/components/reactivation/membership-reactivation-page"
import { buildQuizOfferPreview } from "@/lib/quiz/offer-preview"
import type { QuizAnswers } from "@/lib/quiz/types"

export function ProfileReactivationLab({ profileAnswers }: { profileAnswers: QuizAnswers }) {
  return (
    <MembershipReactivationPage
      firstName="Nick"
      returnDestination="/chat"
      routinePreview={buildQuizOfferPreview(profileAnswers)}
    />
  )
}
