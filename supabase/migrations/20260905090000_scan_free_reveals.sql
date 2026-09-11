-- One-lifetime free-reveal credit ledger for the freemium scanner-first
-- restructure (plans/freemium-scanner-first/plan.md §8, Task T7).
--
-- A row's existence is the used/unused signal: the PRIMARY KEY on user_id
-- caps the ledger at one row per user, so the free-tier credit can only
-- ever be spent once. product_id records what the credit was spent on (catalog product uuid; deliberately no FK — this is a historical spend record that must survive catalog renames/merges/deletions).
--
-- Deliberately separate from the scan attempt log (public.scan_resolve_events
-- and friends) -- this table is the credit ledger, not usage telemetry.
--
-- consumeFreeReveal (src/lib/entitlements/free-reveal.ts) relies on this PK
-- for atomicity via an INSERT unique-violation check, never read-then-write.

-- T7 deferred minor (final triage): IF NOT EXISTS / DROP POLICY IF EXISTS guards,
-- matching the billing precedent and sibling public.scan_wishlist migration
-- (20260820100200) — a rerun of this file must be a no-op, not an error.
CREATE TABLE IF NOT EXISTS public.scan_free_reveals (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revealed_at timestamptz NOT NULL DEFAULT now(),
  product_id uuid NOT NULL
);

ALTER TABLE public.scan_free_reveals ENABLE ROW LEVEL SECURITY;

-- Mirrors public.billing_one_time_purchases (migration 20260731120000): the
-- owner may read their own row, but only the admin client (service_role)
-- writes. consumeFreeReveal needs the PK conflict itself to decide
-- consumed/already_used, so no authenticated INSERT/UPDATE/DELETE policy is
-- granted -- a client-side insert attempt would just be rejected outright
-- rather than racing the accessor's atomicity guarantee.
REVOKE ALL ON TABLE public.scan_free_reveals FROM anon, authenticated;
GRANT SELECT ON TABLE public.scan_free_reveals TO authenticated;
GRANT ALL ON TABLE public.scan_free_reveals TO service_role;

DROP POLICY IF EXISTS scan_free_reveals_select_own
  ON public.scan_free_reveals;
CREATE POLICY scan_free_reveals_select_own
  ON public.scan_free_reveals
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.scan_free_reveals IS
  'One-lifetime free-reveal credit ledger (not the scan attempt log): a row means the user has already spent their free reveal, on product_id.';
