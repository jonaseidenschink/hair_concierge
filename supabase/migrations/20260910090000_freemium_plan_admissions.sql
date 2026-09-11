-- Freemium purchase admission ledger (plans/freemium-scanner-first/plan.md §8, Task T14).
--
-- WHY A RECORD AND NOT AN INFERENCE
-- ---------------------------------
-- A Premium-sheet purchase is an ordinary STANDARD-catalog subscription -- exactly what
-- every legacy pricing-page buyer also has. Nothing in the billing rows distinguishes the
-- two, so Personal-Plan enrollment for freemium buyers cannot be inferred from billing
-- state without retroactively admitting years of legacy subscribers into a journey they
-- never bought. This table is the explicit, auditable statement "THIS user's plan was
-- admitted by THIS purchase", written once at verified activation.
--
-- It sits BESIDE the personal_plan_launch_v1 admission path
-- (src/lib/personal-plan/enrollment.ts, launch-catalog subscription correlated to one exact
-- quiz lead through funnel_sessions), which is untouched: that path needs a funnel
-- correlation the freemium flow does not have, and this path needs a marker that path does
-- not carry.
--
-- GRANTS NO ACCESS BY ITSELF
-- --------------------------
-- Like the migration-admission record it is modelled on
-- (20260828104243_personal_plan_paid_migration_admission.sql), a row here binds the plan's
-- SOURCE; the reader still rechecks current paid authority on every request. A cancelled or
-- lapsed subscription therefore loses access with the row still in place -- and regains the
-- same plan, with the same enrollment id, if the person resubscribes.
--
-- IDEMPOTENCY
-- -----------
-- One row per user (UNIQUE user_id) and one row per provider purchase (unique index): a webhook
-- replay, a double completion callback, and a refresh during a pending payment all converge
-- on the same row and therefore the same enrollment id -- which is what keeps
-- personal_plans.enrollment_purchase_source_id (pinned on first write by
-- personal_plan_create_or_reuse_initial_need) stable across every one of those paths.

CREATE TABLE public.freemium_plan_admissions (
  -- The plan's enrollment source identity. personal_plans.enrollment_purchase_source_id is
  -- pinned to THIS id, never to the provider reference: a provider subscription id changes
  -- when a lapsed buyer resubscribes, and the pin has to survive that.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  -- Stripe Checkout Session id / PayPal subscription id: the purchase that admitted the
  -- plan. Kept for support and reconciliation; never used to grant access.
  provider_reference text NOT NULL,
  -- The prepared quiz artifact's lead. The journey loader resolves a plan owner's artifact
  -- by (user_id, lead_id) (src/lib/personal-plan/journey-access-loader.ts), so admission
  -- has to name the lead, not just the user.
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE RESTRICT,
  admitted_at timestamptz NOT NULL DEFAULT now()
);

-- The same provider purchase must never admit two different users.
CREATE UNIQUE INDEX freemium_plan_admissions_provider_reference_key
  ON public.freemium_plan_admissions (provider, provider_reference);

ALTER TABLE public.freemium_plan_admissions ENABLE ROW LEVEL SECURITY;

-- Same posture as public.scan_free_reveals (20260905090000): the owner may read their own
-- admission, only the service-role admin client writes it. There is no authenticated
-- INSERT/UPDATE/DELETE policy -- admission is a server decision taken after a verified
-- payment, never something a browser can assert.
REVOKE ALL ON TABLE public.freemium_plan_admissions FROM anon, authenticated;
GRANT SELECT ON TABLE public.freemium_plan_admissions TO authenticated;
GRANT ALL ON TABLE public.freemium_plan_admissions TO service_role;

CREATE POLICY freemium_plan_admissions_select_own
  ON public.freemium_plan_admissions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.freemium_plan_admissions IS
  'Freemium (Premium-sheet) purchase admission: binds a user''s Personal Plan to the standard-catalog purchase that admitted it. Grants no access on its own -- paid authority is rechecked live.';
