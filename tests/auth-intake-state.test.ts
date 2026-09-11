import assert from "node:assert/strict"
import test from "node:test"

import {
  canBypassLegacyOnboardingForPersonalPlanRoutine,
  getAuthenticatedAppRedirect,
  hasQuizDiagnostics,
  isPersonalPlanOnboardingBypassRoute,
  resolveIntakeState,
} from "../src/lib/auth/intake-state"

const completeQuizProfile = {
  hair_texture: "wavy",
  thickness: "normal",
  density: "medium",
  cuticle_condition: "slightly_rough",
  protein_moisture_balance: "stretches_stays",
  scalp_type: "dry",
  scalp_condition: "dry_flakes",
  chemical_treatment: ["colored"],
  concerns: ["dryness"],
}

test("hasQuizDiagnostics returns false when hair profile is missing", () => {
  assert.equal(hasQuizDiagnostics(null), false)
})

test("hasQuizDiagnostics accepts a completed no-issue scalp answer", () => {
  assert.equal(hasQuizDiagnostics({ ...completeQuizProfile, scalp_condition: null }), true)
})

test("hasQuizDiagnostics requires every other quiz-written field", () => {
  const missingDensityProfile: Partial<typeof completeQuizProfile> = { ...completeQuizProfile }
  delete missingDensityProfile.density

  assert.equal(hasQuizDiagnostics(missingDensityProfile), false)
  assert.equal(hasQuizDiagnostics({ ...completeQuizProfile, density: null }), false)
  assert.equal(hasQuizDiagnostics({ ...completeQuizProfile, chemical_treatment: [] }), false)
  assert.equal(hasQuizDiagnostics({ ...completeQuizProfile, concerns: null }), false)
  assert.equal(hasQuizDiagnostics({ ...completeQuizProfile, concerns: undefined }), false)
})

test("resolveIntakeState returns ready when onboarding is already completed", () => {
  assert.equal(resolveIntakeState({ onboarding_completed: true }, null), "ready")
})

test("resolveIntakeState returns needs_onboarding for quiz-complete users", () => {
  assert.equal(
    resolveIntakeState({ onboarding_completed: false }, completeQuizProfile),
    "needs_onboarding",
  )
})

test("resolveIntakeState returns needs_quiz for quizless users", () => {
  assert.equal(resolveIntakeState({ onboarding_completed: false }, null), "needs_quiz")
})

test("getAuthenticatedAppRedirect maps entry routes from intake state", () => {
  assert.equal(getAuthenticatedAppRedirect("/auth", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/auth", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/auth", "ready"), "/chat")
  assert.equal(getAuthenticatedAppRedirect("/chat", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/chat", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/chat", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/routine", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/routine", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/routine", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/routine/current", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/routine/current", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/routine/current", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/anwendung", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/anwendung", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/anwendung", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/anwendung/wash_day", "needs_quiz"), "/quiz")
  assert.equal(
    getAuthenticatedAppRedirect("/anwendung/wash_day", "needs_onboarding"),
    "/onboarding",
  )
  assert.equal(getAuthenticatedAppRedirect("/anwendung/wash_day", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/scan", "needs_quiz"), "/quiz")
  assert.equal(getAuthenticatedAppRedirect("/scan", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/scan", "ready"), null)
  assert.equal(getAuthenticatedAppRedirect("/quiz", "needs_quiz"), null)
  assert.equal(getAuthenticatedAppRedirect("/quiz", "needs_onboarding"), "/onboarding")
  assert.equal(getAuthenticatedAppRedirect("/quiz", "ready"), "/chat")
  // `/` is now the marketing landing — middleware no longer routes it
  // through this function. Verify the function returns null for `/` so
  // any future stray caller is a no-op rather than a redirect.
  assert.equal(getAuthenticatedAppRedirect("/", "needs_quiz"), null)
  assert.equal(getAuthenticatedAppRedirect("/", "needs_onboarding"), null)
  assert.equal(getAuthenticatedAppRedirect("/", "ready"), null)
})

test("getAuthenticatedAppRedirect preserves quiz retake access", () => {
  assert.equal(getAuthenticatedAppRedirect("/quiz", "ready", { isQuizRetake: true }), null)
})

test("active Personal Plan access with a pending proposal permits the Stage 4 routine route", () => {
  const pendingRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: "proposal-1",
    activeRoutineVersionId: null,
  }

  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/routine", pendingRoutine), true)
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/routine/current", pendingRoutine),
    true,
  )
  assert.equal(
    getAuthenticatedAppRedirect("/routine", "needs_onboarding", {
      personalPlanRoutineAccess: pendingRoutine,
    }),
    null,
  )
})

test("anwendung still requires an active routine version", () => {
  const pendingRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: "proposal-1",
    activeRoutineVersionId: null,
  }
  const activeRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: null,
    activeRoutineVersionId: "routine-1",
  }

  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/anwendung", pendingRoutine), false)
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/anwendung/wash_day", activeRoutine),
    true,
  )
})

test("Personal Plan access without a pending or active routine remains blocked", () => {
  assert.equal(
    getAuthenticatedAppRedirect("/routine", "needs_onboarding", {
      personalPlanRoutineAccess: {
        hasActivePersonalPlanEntitlement: true,
        pendingRoutineProposalId: null,
        activeRoutineVersionId: null,
      },
    }),
    "/onboarding",
  )
})

test("field-test metadata without active app access does not bypass legacy onboarding", () => {
  assert.equal(
    getAuthenticatedAppRedirect("/routine", "needs_onboarding", {
      personalPlanRoutineAccess: {
        hasActivePersonalPlanEntitlement: false,
        pendingRoutineProposalId: "proposal-1",
        activeRoutineVersionId: null,
      },
    }),
    "/onboarding",
  )
})

test("one-time purchasers retain Personal Plan routine access", () => {
  const activeRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: null,
    activeRoutineVersionId: "routine-1",
  }

  assert.equal(
    getAuthenticatedAppRedirect("/anwendung", "needs_onboarding", {
      personalPlanRoutineAccess: activeRoutine,
    }),
    null,
  )
})

test("chat bypasses legacy onboarding with a pending or active routine", () => {
  const activeRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: null,
    activeRoutineVersionId: "routine-1",
  }
  const pendingRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: "proposal-1",
    activeRoutineVersionId: null,
  }

  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", activeRoutine), true)
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", pendingRoutine), true)
  assert.equal(
    getAuthenticatedAppRedirect("/chat", "needs_onboarding", {
      personalPlanRoutineAccess: activeRoutine,
    }),
    null,
  )
})

test("chat keeps legacy onboarding without entitlement or routine pointers", () => {
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", undefined), false)
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", {
      hasActivePersonalPlanEntitlement: true,
      pendingRoutineProposalId: null,
      activeRoutineVersionId: null,
    }),
    false,
  )
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", {
      hasActivePersonalPlanEntitlement: false,
      pendingRoutineProposalId: "proposal-1",
      activeRoutineVersionId: "routine-1",
    }),
    false,
  )
  assert.equal(
    getAuthenticatedAppRedirect("/chat", "needs_quiz", {
      personalPlanRoutineAccess: {
        hasActivePersonalPlanEntitlement: true,
        pendingRoutineProposalId: null,
        activeRoutineVersionId: "routine-1",
      },
    }),
    "/quiz",
  )
})

test("the onboarding bypass route set covers routine, anwendung, chat and scan", () => {
  assert.equal(isPersonalPlanOnboardingBypassRoute("/routine"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/anwendung/wash_day"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/chat"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/chat/verlauf"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/scan"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/scan/ergebnis"), true)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/tracker"), false)
  assert.equal(isPersonalPlanOnboardingBypassRoute("/onboarding"), false)
})

test("scan bypasses legacy onboarding for any personal-plan entitlement holder, regardless of routine pointers", () => {
  const activeRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: null,
    activeRoutineVersionId: "routine-1",
  }
  const pendingRoutine = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: "proposal-1",
    activeRoutineVersionId: null,
  }
  const noRoutinePointers = {
    hasActivePersonalPlanEntitlement: true,
    pendingRoutineProposalId: null,
    activeRoutineVersionId: null,
  }

  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", activeRoutine), true)
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", pendingRoutine), true)
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", noRoutinePointers), true)
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", undefined), false)
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", {
      hasActivePersonalPlanEntitlement: false,
      pendingRoutineProposalId: "proposal-1",
      activeRoutineVersionId: "routine-1",
    }),
    false,
  )

  // A fresh personal-plan buyer with a completed quiz but unfinished legacy
  // onboarding, and no routine pointers yet, must still reach /scan: the
  // verdict engine only needs the quiz-written hair profile, and quiz
  // completion is enforced downstream by the scan page's own gate
  // (loadScanRouteAccess -> redirect to /quiz), not by this bypass.
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_onboarding", {
      personalPlanRoutineAccess: noRoutinePointers,
    }),
    null,
  )
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_onboarding", {
      personalPlanRoutineAccess: activeRoutine,
    }),
    null,
  )

  // A user who hasn't completed the quiz yet is still sent to /quiz first,
  // even with an active personal-plan entitlement — the /scan bypass only
  // applies once intake state has already progressed past needs_quiz.
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_quiz", {
      personalPlanRoutineAccess: activeRoutine,
    }),
    "/quiz",
  )
})

// --- Freemium scanner-first flag (T2) --------------------------------------

test("flag off: canBypassLegacyOnboardingForPersonalPlanRoutine for /scan is unchanged (still requires entitlement)", () => {
  assert.equal(canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", undefined), false)
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", undefined, {
      freemiumScannerFirstEnabled: false,
    }),
    false,
  )
})

test("flag on: /scan bypasses legacy onboarding with no entitlement at all", () => {
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/scan", undefined, {
      freemiumScannerFirstEnabled: true,
    }),
    true,
  )
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine(
      "/scan",
      {
        hasActivePersonalPlanEntitlement: false,
        pendingRoutineProposalId: null,
        activeRoutineVersionId: null,
      },
      { freemiumScannerFirstEnabled: true },
    ),
    true,
  )
})

test("flag on: /scan decoupling does not leak to routine, anwendung or chat", () => {
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/routine", undefined, {
      freemiumScannerFirstEnabled: true,
    }),
    false,
  )
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/anwendung", undefined, {
      freemiumScannerFirstEnabled: true,
    }),
    false,
  )
  assert.equal(
    canBypassLegacyOnboardingForPersonalPlanRoutine("/chat", undefined, {
      freemiumScannerFirstEnabled: true,
    }),
    false,
  )
})

test("flag on: getAuthenticatedAppRedirect lets a quiz-complete, entitlement-less user reach /scan", () => {
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_onboarding", {
      freemiumScannerFirstEnabled: true,
    }),
    null,
  )
})

test("flag off: getAuthenticatedAppRedirect still bounces the same user to /onboarding", () => {
  assert.equal(getAuthenticatedAppRedirect("/scan", "needs_onboarding"), "/onboarding")
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_onboarding", {
      freemiumScannerFirstEnabled: false,
    }),
    "/onboarding",
  )
})

test("flag on: quiz-incomplete users are still sent to /quiz before /scan, unaffected by the flag", () => {
  assert.equal(
    getAuthenticatedAppRedirect("/scan", "needs_quiz", {
      freemiumScannerFirstEnabled: true,
    }),
    "/quiz",
  )
})
