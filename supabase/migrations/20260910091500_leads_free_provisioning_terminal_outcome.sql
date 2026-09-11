-- Terminal marker for free-tier initial-need provisioning (T18 fix round 2, review finding N3).
--
-- WHY
-- ---
-- `free-snapshot-service.ts` signals `no_quiz_artifact` and `invalid_source` as typed,
-- non-throwing outcomes that never self-heal: the underlying condition (no linked quiz
-- artifact, or an artifact `computeNeedPlan` refuses) does not change on a later attempt.
-- Before this column existed, `src/lib/auth/free-registration-recovery.ts`'s `/scan` retry had
-- no way to tell "permanently broken" apart from "haven't tried yet", so it re-entered
-- provisioning and re-reported a Sentry `error` on every single render of a stuck account --
-- unbounded, for as long as that account keeps visiting `/scan`.
--
-- WHY THE LEADS ROW
-- ------------------
-- The claimed `leads` row (`quiz_kind = 'personal_plan'`, `user_id` set once
-- `linkQuizToProfile` claims it) is the cheapest honest home: it already exists for every
-- account that can reach free provisioning at all (both the "confirm" and "scan_retry"
-- callers), already carries free-registration-specific state (`quiz_kind`,
-- `artifact_email_status`), and needs no new table. `personal_plans` was considered and
-- rejected: neither terminal outcome ever reaches `personal_plan_create_or_reuse_initial_need`,
-- so no `personal_plans` row exists yet to hold a marker on, and inserting a bare one purely
-- for this would misrepresent "has a plan" to every other reader of that table.
--
-- GRANTS NO OUTCOME BY ITSELF
-- ---------------------------
-- A NULL value is the overwhelmingly common case (still trying, or already provisioned) and
-- carries no meaning beyond "not marked terminal yet". Only `recoverMissingFreeSnapshot`
-- writes this column, and only after a `no_quiz_artifact`/`invalid_source` outcome.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS free_provisioning_terminal_outcome text;

DO $$
BEGIN
  ALTER TABLE public.leads
    DROP CONSTRAINT IF EXISTS leads_free_provisioning_terminal_outcome_check;

  ALTER TABLE public.leads
    ADD CONSTRAINT leads_free_provisioning_terminal_outcome_check
    CHECK (
      free_provisioning_terminal_outcome IS NULL
      OR free_provisioning_terminal_outcome IN ('no_quiz_artifact', 'invalid_source')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The recovery retry looks this up by `user_id` (it only ever has the signed-in user id, not
-- a lead id) on every free-tier `/scan` render, so this index is what keeps that lookup a
-- single indexed read rather than a per-render table scan.
CREATE INDEX IF NOT EXISTS leads_user_id_idx
  ON public.leads (user_id)
  WHERE user_id IS NOT NULL;
