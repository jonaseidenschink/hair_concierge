import assert from "node:assert/strict"
import test from "node:test"

import { buildQuizOfferPreview } from "../src/lib/quiz/offer-preview"
import { buildQuizAnswersFromHairProfile } from "../src/lib/reactivation/profile-quiz-answers"
import {
  DEFAULT_REACTIVATION_RETURN_DESTINATION,
  sanitizeReactivationReturnDestination,
} from "../src/lib/reactivation/return-destination"

test("saved canonical hair-profile values map back to quiz answers", () => {
  const answers = buildQuizAnswersFromHairProfile({
    hair_texture: "wavy",
    thickness: "coarse",
    density: "high",
    hair_length: "long",
    cuticle_condition: "slightly_rough",
    protein_moisture_balance: "stretches_stays",
    scalp_type: "dry",
    scalp_condition: "dry_flakes",
    chemical_treatment: ["colored", "bleached"],
    concerns: ["hair_loss", "dryness", "breakage", "frizz"],
    goals: ["moisture", "shine", "strengthen"],
  })

  assert.deepEqual(answers, {
    structure: "wavy",
    thickness: "coarse",
    density: "high",
    hair_length: "long",
    fingertest: "leicht_uneben",
    pulltest: "stretches_stays",
    scalp_type: "trocken",
    has_scalp_issue: true,
    scalp_condition: "trockene_schuppen",
    concerns: ["breakage", "dryness", "frizz"],
    concerns_other_text: undefined,
    treatment: ["gefaerbt", "blondiert"],
    goals: ["moisture", "shine", "strengthen"],
  })
})

test("every canonical reverse mapping is explicit", () => {
  const cases = [
    ["hair_texture", ["straight", "wavy", "curly", "coily"], "structure"],
    ["thickness", ["fine", "normal", "coarse"], "thickness"],
    ["density", ["low", "medium", "high"], "density"],
    ["hair_length", ["very_short", "short", "medium", "long", "very_long"], "hair_length"],
    ["cuticle_condition", ["smooth", "slightly_rough", "rough"], "fingertest"],
    ["protein_moisture_balance", ["snaps", "stretches_bounces", "stretches_stays"], "pulltest"],
    ["scalp_type", ["oily", "balanced", "dry"], "scalp_type"],
  ] as const

  for (const [profileField, values, answerField] of cases) {
    for (const value of values) {
      const answers = buildQuizAnswersFromHairProfile({ [profileField]: value })
      assert.notEqual(answers[answerField], undefined, `${profileField}=${value}`)
    }
  }

  const treatmentAnswers = buildQuizAnswersFromHairProfile({
    chemical_treatment: ["natural", "colored", "bleached", "permed", "chemically_straightened"],
  })
  assert.deepEqual(treatmentAnswers.treatment, [
    "gefaerbt",
    "blondiert",
    "dauerwelle",
    "chemisch_geglaettet",
  ])
})

test("scalp issue flag follows mapped stored condition", () => {
  const dandruff = buildQuizAnswersFromHairProfile({ scalp_condition: "dandruff" })
  assert.equal(dandruff.has_scalp_issue, true)
  assert.equal(dandruff.scalp_condition, "schuppen")
  assert.equal(buildQuizAnswersFromHairProfile({ scalp_condition: null }).has_scalp_issue, false)
  assert.equal(buildQuizAnswersFromHairProfile({ scalp_condition: "none" }).has_scalp_issue, false)
})

test("missing and legacy profile values do not invent quiz precision", () => {
  const answers = buildQuizAnswersFromHairProfile({
    hair_texture: "wellig",
    thickness: "mittel",
    density: null,
    cuticle_condition: "medium_porosity",
    protein_moisture_balance: "unknown",
    scalp_type: "fettig",
    scalp_condition: "eczema",
    chemical_treatment: ["unknown"],
    concerns: ["hair_loss", "unknown"],
    goals: ["hair_growth", "unknown"],
  })

  assert.deepEqual(answers, {
    structure: undefined,
    thickness: undefined,
    density: undefined,
    hair_length: undefined,
    fingertest: undefined,
    pulltest: undefined,
    scalp_type: undefined,
    has_scalp_issue: false,
    scalp_condition: undefined,
    concerns: [],
    concerns_other_text: undefined,
    treatment: undefined,
    goals: undefined,
  })

  const preview = buildQuizOfferPreview(answers)
  assert.equal(preview.needs.shampoo.scalpRoute, "balanced")
  assert.equal(preview.needs.shampoo.thickness, "normal")
  assert.equal(preview.needs.conditioner.weight, "medium")
})

test("reactivation return destination accepts only allowlisted member pages", () => {
  for (const destination of ["/chat", "/routine", "/tracker", "/profile", "/onboarding"]) {
    assert.equal(sanitizeReactivationReturnDestination(destination), destination)
  }

  assert.equal(
    sanitizeReactivationReturnDestination("/chat?conversation=abc-123&source=reactivation"),
    "/chat?conversation=abc-123&source=reactivation",
  )
  assert.equal(
    sanitizeReactivationReturnDestination("/profile?tab=membership"),
    "/profile?tab=membership",
  )
})

test("reactivation return destination rejects external, recursive, escaped and unknown paths", () => {
  const invalidDestinations = [
    null,
    "",
    "https://evil.example/chat",
    "//evil.example/chat",
    "/\\evil.example/chat",
    "/reactivate",
    "/reactivate?next=/chat",
    "/pricing",
    "/chat/other",
    "/chat/../profile",
    "/chat%2f..%2fprofile",
    "/%252f%252fevil.example/chat",
    "/chat#membership",
    "/chat?next=%2F%2Fevil.example",
    "/onboarding?returnTo=%2F%2Fevil.example",
    "/chat\r\nLocation: https://evil.example",
  ]

  for (const destination of invalidDestinations) {
    assert.equal(
      sanitizeReactivationReturnDestination(destination),
      DEFAULT_REACTIVATION_RETURN_DESTINATION,
      String(destination),
    )
  }
})
