import { notFound } from "next/navigation"

import { ProfileReactivationLab } from "@/components/labs/profile-reactivation-lab"
import type { QuizAnswers } from "@/lib/quiz/types"

const SAVED_PROFILE_ANSWERS: QuizAnswers = {
  structure: "wavy",
  thickness: "normal",
  density: "medium",
  hair_length: "long",
  fingertest: "rau",
  pulltest: "stretches_bounces",
  scalp_type: "ausgeglichen",
  has_scalp_issue: false,
  concerns: ["frizz", "dryness"],
  treatment: ["natur"],
  goals: ["less_frizz", "moisture", "shine"],
}

export default function ProfileReactivationPageLab() {
  if (process.env.NODE_ENV !== "development") notFound()

  return <ProfileReactivationLab profileAnswers={SAVED_PROFILE_ANSWERS} />
}
