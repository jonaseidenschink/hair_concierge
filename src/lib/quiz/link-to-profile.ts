import { createAdminClient } from "@/lib/supabase/admin"
import { hasCompletedQuizDiagnostics } from "./completion"
import type { QuizAnswers } from "./types"
import { normalizeStoredQuizAnswers, projectQuizAnswersToLegacyVocabulary } from "./normalization"

export function canLinkDirectQuizLead(
  lead: { email: string; userId: string | null },
  account: { email?: string; userId: string },
): boolean {
  if (lead.userId) return lead.userId === account.userId
  if (!account.email) return false
  return lead.email.trim().toLowerCase() === account.email.trim().toLowerCase()
}

export function resolveProfileDensityFromQuizAnswers(answers: QuizAnswers): string | undefined {
  if (answers.density) return answers.density

  const hasCompleteLegacyDiagnostics =
    Boolean(answers.structure) &&
    Boolean(answers.thickness) &&
    Boolean(answers.fingertest) &&
    Boolean(answers.pulltest) &&
    Boolean(answers.scalp_type) &&
    typeof answers.has_scalp_issue === "boolean" &&
    (!answers.has_scalp_issue || Boolean(answers.scalp_condition)) &&
    Array.isArray(answers.treatment) &&
    answers.treatment.length > 0 &&
    Array.isArray(answers.concerns)

  return hasCompleteLegacyDiagnostics ? "medium" : undefined
}

export function buildProfileDataFromQuizAnswers(answers: QuizAnswers): Record<string, unknown> {
  const profileData: Record<string, unknown> = {}

  if (answers.structure) profileData.hair_texture = answers.structure
  if (answers.thickness) profileData.thickness = answers.thickness
  if (answers.hair_length) profileData.hair_length = answers.hair_length
  const density = resolveProfileDensityFromQuizAnswers(answers)
  if (density) profileData.density = density

  // Map quiz cuticle condition keys to English
  const CUTICLE_MAP: Record<string, string> = {
    glatt: "smooth",
    leicht_uneben: "slightly_rough",
    rau: "rough",
  }
  if (answers.fingertest)
    profileData.cuticle_condition = CUTICLE_MAP[answers.fingertest] ?? answers.fingertest
  if (answers.pulltest) profileData.protein_moisture_balance = answers.pulltest

  // Map quiz scalp keys to English
  const SCALP_TYPE_MAP: Record<string, string> = {
    fettig: "oily",
    ausgeglichen: "balanced",
    trocken: "dry",
  }
  const SCALP_CONDITION_MAP: Record<string, string> = {
    schuppen: "dandruff",
    trockene_schuppen: "dry_flakes",
    gereizt: "irritated",
  }

  if (answers.scalp_type) {
    profileData.scalp_type = SCALP_TYPE_MAP[answers.scalp_type] ?? answers.scalp_type
  }
  if (answers.scalp_condition) {
    profileData.scalp_condition =
      SCALP_CONDITION_MAP[answers.scalp_condition] ?? answers.scalp_condition
  } else if (answers.has_scalp_issue === false) {
    profileData.scalp_condition = null
  }
  if (answers.concerns !== undefined) {
    profileData.concerns = projectQuizAnswersToLegacyVocabulary(answers).concerns
  }

  // Map quiz chemical treatment keys to English
  const TREATMENT_MAP: Record<string, string> = {
    natur: "natural",
    gefaerbt: "colored",
    blondiert: "bleached",
    dauerwelle: "permed",
    chemisch_geglaettet: "chemically_straightened",
  }
  if (answers.treatment) {
    profileData.chemical_treatment = answers.treatment.map((t: string) => TREATMENT_MAP[t] ?? t)
  }

  return profileData
}

export function buildProfileDataFromPersonalPlanCanonicalProfile(
  canonicalProfile: unknown,
): Record<string, unknown> {
  if (!isRecord(canonicalProfile)) {
    throw new Error("personal plan has invalid canonical diagnostics")
  }
  const answers = normalizeStoredQuizAnswers(canonicalProfile)
  if (!answers) {
    throw new Error("personal plan has invalid canonical diagnostics")
  }

  const profileData = buildProfileDataFromQuizAnswers(answers)
  const legacyVocabulary = projectQuizAnswersToLegacyVocabulary(answers)
  if (legacyVocabulary.goals.length > 0) {
    profileData.goals = legacyVocabulary.goals
  }

  if (!hasCompletedQuizDiagnostics(profileData)) {
    throw new Error("personal plan has incomplete canonical diagnostics")
  }

  return profileData
}

export type LinkQuizToProfileOptions = {
  /**
   * `"create_only"` — the FREE-registration binding mode (PR6 review, finding
   * V4). The confirm route reads bind evidence ("does this account already have
   * a profile?") and then calls this function; a profile created in that window
   * — a concurrent paid activation or onboarding — used to be overwritten
   * unconditionally by the `existing` branch below. In this mode the
   * `hair_profiles` write may CREATE but never overwrite, and a lost insert race
   * (the table's `user_id UNIQUE`, so the DB itself adjudicates) is resolved by
   * standing down rather than by re-reading and updating.
   *
   * Omitted everywhere else, so legacy and paid linking behave exactly as before.
   */
  profileWrite?: "create_only"
  /** Injection seam for tests; production always builds its own admin client. */
  admin?: ReturnType<typeof createAdminClient>
}

/**
 * After a user authenticates, link their quiz lead data to their profile.
 *
 * Strategy:
 *  1. Try direct lead ID lookup (if leadId passed from quiz CTA)
 *  2. Fall back to email lookup (most recent unlinked lead)
 *  3. Create/update hair_profiles with mapped quiz data
 *  4. Set leads.user_id to mark the lead as linked
 */
export async function linkQuizToProfile(
  userId: string,
  email: string | undefined,
  leadId?: string,
  options?: LinkQuizToProfileOptions,
) {
  console.log("[linkQuizToProfile] start", { userId, email, leadId })

  const admin = options?.admin ?? createAdminClient()
  const createOnly = options?.profileWrite === "create_only"

  // --- Find the lead ---
  let lead: {
    id: string
    email: string
    quiz_kind: "legacy" | "personal_plan"
    quiz_answers: QuizAnswers | Record<string, unknown> | null
    user_id: string | null
  } | null = null

  // Primary: direct ID lookup
  if (leadId) {
    const { data, error } = await admin
      .from("leads")
      .select("id, email, quiz_kind, quiz_answers, user_id")
      .eq("id", leadId)
      .single()

    if (error && error.code !== "PGRST116") {
      throw new Error(`Lead lookup by id failed: ${error.message}`)
    }

    if (
      data &&
      !canLinkDirectQuizLead({ email: data.email, userId: data.user_id }, { email, userId })
    ) {
      console.warn("[linkQuizToProfile] direct lead does not match account; trying email fallback")
    } else if (data && (data.quiz_kind === "legacy" || data.quiz_kind === "personal_plan")) {
      // Allow same-user retries so an interrupted profile projection can recover.
      lead = data
    }
  }

  // Fallback: email lookup (most recent unlinked)
  if (!lead && email) {
    const { data, error } = await admin
      .from("leads")
      .select("id, email, quiz_kind, quiz_answers, user_id")
      .eq("email", email.toLowerCase())
      .eq("quiz_kind", "legacy")
      .is("user_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error && error.code !== "PGRST116") {
      throw new Error(`Lead lookup by email failed: ${error.message}`)
    }
    lead = data?.quiz_kind === "legacy" ? data : null
  }

  // No matching lead — user didn't come from quiz
  if (!lead) {
    console.log("[linkQuizToProfile] no matching lead found, skipping")
    return
  }

  const { profileData, incomingGoals } =
    lead.quiz_kind === "personal_plan"
      ? await preparePersonalPlanProfileProjection(admin, lead.id, userId)
      : prepareLegacyProfileProjection(lead.quiz_answers)

  if (!profileData) {
    console.log("[linkQuizToProfile] lead has no usable quiz diagnostics, skipping")
    return
  }

  profileData.user_id = userId
  delete profileData.goals

  // --- Check if hair_profiles row already exists ---
  const { data: existing, error: fetchErr } = await admin
    .from("hair_profiles")
    .select("id, goals")
    .eq("user_id", userId)
    .single()

  if (fetchErr && fetchErr.code !== "PGRST116") {
    throw new Error(`hair_profiles lookup failed: ${fetchErr.message}`)
  }

  if (existing) {
    // V4: a free bind never clobbers a profile that exists by the time we write.
    if (createOnly) {
      console.warn(
        "[linkQuizToProfile] create_only: the account already has a profile — standing down",
        { userId, leadId: lead.id },
      )
      return
    }
    const updates = { ...profileData }
    delete updates.user_id

    // Only write goals if user has none yet — never clobber existing goals from
    // a stale unlinked lead matched via the email fallback above.
    const existingGoals = (existing as { goals: string[] | null }).goals
    if (incomingGoals && (!existingGoals || existingGoals.length === 0)) {
      updates.goals = incomingGoals
      updates.desired_volume = null
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateErr } = await admin
        .from("hair_profiles")
        .update(updates)
        .eq("id", existing.id)
      if (updateErr) {
        throw new Error(`hair_profiles update failed: ${updateErr.message}`)
      }
      console.log("[linkQuizToProfile] updated existing profile", existing.id)
    }
  } else {
    // Create new hair_profiles row
    if (incomingGoals) {
      profileData.goals = incomingGoals
      profileData.desired_volume = null
    }
    const { error: insertErr } = await admin.from("hair_profiles").insert(profileData)
    if (insertErr) {
      // V4: the TOCTOU window itself. `hair_profiles.user_id` is UNIQUE, so a
      // profile created between the read above and this insert makes the DB
      // reject it (23505) — which is exactly the answer a free bind must accept.
      // Nothing is re-read and nothing is updated: the concurrent writer wins.
      if (createOnly && isUniqueViolation(insertErr)) {
        console.warn(
          "[linkQuizToProfile] create_only: lost the profile-creation race — standing down",
          { userId, leadId: lead.id },
        )
        return
      }
      throw new Error(`hair_profiles insert failed: ${insertErr.message}`)
    }
    console.log("[linkQuizToProfile] created new profile for user", userId)
  }

  // --- Link the lead to the user ---
  const { error: linkErr } = await admin
    .from("leads")
    .update({ user_id: userId, status: "linked" })
    .eq("id", lead.id)
  if (linkErr) {
    throw new Error(`leads.user_id update failed: ${linkErr.message}`)
  }

  console.log("[linkQuizToProfile] done — lead", lead.id, "linked to user", userId)
}

function prepareLegacyProfileProjection(quizAnswers: unknown): {
  profileData: Record<string, unknown> | null
  incomingGoals: string[] | null
} {
  const answers = isRecord(quizAnswers) ? normalizeStoredQuizAnswers(quizAnswers) : null
  if (!answers) return { profileData: null, incomingGoals: null }

  console.log("[linkQuizToProfile] legacy answers:", Object.keys(answers))
  return {
    profileData: buildProfileDataFromQuizAnswers(answers),
    incomingGoals: (() => {
      const goals = projectQuizAnswersToLegacyVocabulary(answers).goals
      return goals.length > 0 ? goals : null
    })(),
  }
}

async function preparePersonalPlanProfileProjection(
  admin: ReturnType<typeof createAdminClient>,
  leadId: string,
  userId: string,
): Promise<{
  profileData: Record<string, unknown>
  incomingGoals: string[] | null
}> {
  const { data, error } = await admin.rpc("link_personal_plan_artifact_to_user", {
    p_lead_id: leadId,
    p_user_id: userId,
  })

  if (error) {
    throw new Error(`personal plan artifact link failed: ${error.message}`)
  }

  const result = Array.isArray(data) ? data[0] : data
  if (!isRecord(result) || !("canonical_profile" in result)) {
    throw new Error("personal plan artifact link returned no canonical diagnostics")
  }

  const profileData = buildProfileDataFromPersonalPlanCanonicalProfile(result.canonical_profile)
  const incomingGoals =
    Array.isArray(profileData.goals) && profileData.goals.length > 0
      ? (profileData.goals as string[])
      : null

  return { profileData, incomingGoals }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Postgres `unique_violation` as PostgREST reports it. */
function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505"
}
