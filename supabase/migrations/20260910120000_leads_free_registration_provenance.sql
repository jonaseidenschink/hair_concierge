-- Free-registration PROVENANCE marker on the lead (PR6 Codex review, finding V3).
--
-- WHY
-- ---
-- `/auth/confirm` decided "free branch or paid branch" from the URL alone: `?free=1`, a UUID
-- `?lead=`, and a `/scan` landing. Both directions of that were reproducible:
--
--   (a) a GENUINE free-registration token with `free=1` removed (or `next` pointed
--       elsewhere) skipped the bind-evidence containment entirely, so `linkQuizToProfile`
--       reached an established account's `hair_profiles` row and overwrote it;
--   (b) a payment-activation token with `free=1&lead=<uuid>&next=/scan` bolted on took the
--       free branch, whose write pins `personal_plans.enrollment_purchase_source_id = null`
--       permanently and breaks that user's paid plan forever.
--
-- Caller-supplied parameters cannot be evidence of origin. This column is: it is written
-- ONLY by `/api/auth/free-registration`, server-side, immediately before that endpoint mails
-- a free-registration magic link, and it is what `/auth/confirm` branches on.
--
-- WHY THE LEADS ROW, AND WHY AT SEND RATHER THAN AT LEAD CREATION
-- ---------------------------------------------------------------
-- Quiz completion creates the same `leads` row for the paid and the free funnel — at that
-- moment nothing distinguishes them except a flag read that can change before the visitor
-- ever registers. The act that actually makes a lead a FREE-REGISTRATION lead is the send:
-- one endpoint, one code path, and exactly the link whose confirm has to be honoured. The
-- `leads` row already carries every other piece of free-registration state (`quiz_kind`,
-- `artifact_email_status`, `free_provisioning_terminal_outcome`), so this needs no new table.
--
-- GRANTS NO ACCESS BY ITSELF
-- --------------------------
-- The marker only says "a free-registration link was minted for this lead". Binding still
-- requires a verified Supabase token, `canLinkDirectQuizLead`, and the bind-evidence
-- containment (`resolveFreeRegistrationBind`) — which this column now also switches ON for
-- any confirm that touches a free-provenance lead, whatever its parameters say.
--
-- NOT NULLABLE-BY-MEANING: NULL is the overwhelmingly common case (every paid-funnel lead,
-- and every free lead before its first send) and means only "no free-registration link was
-- ever minted for this lead".

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS free_registration_requested_at timestamptz;

COMMENT ON COLUMN public.leads.free_registration_requested_at IS
  'Set by /api/auth/free-registration immediately before a free-registration magic link is mailed for this lead. Server-side provenance for /auth/confirm''s free branch and its bind containment; grants no access on its own.';
