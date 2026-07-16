-- Routine tracker: per-day usage logs + nudge dismissals.
-- Spec: docs/superpowers/specs/2026-07-07-routine-tracker-design.md

CREATE TABLE public.routine_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  logged_on date NOT NULL,
  timezone text NOT NULL,
  day_type text NOT NULL CHECK (day_type IN ('wash','clarifying','treatment_only','styling_only','none')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, logged_on)
);

CREATE INDEX IF NOT EXISTS idx_routine_logs_user_logged_on
  ON public.routine_logs (user_id, logged_on DESC);

CREATE TABLE public.routine_log_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_log_id uuid NOT NULL REFERENCES public.routine_logs(id) ON DELETE CASCADE,
  category text NOT NULL REFERENCES public.product_categories(key) ON DELETE RESTRICT,
  user_product_usage_id uuid REFERENCES public.user_product_usage(id) ON DELETE SET NULL,
  product_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routine_log_products_log_id
  ON public.routine_log_products (routine_log_id);

-- Cooldown dismissals (house pattern from 20260706130000_dismissed_suggestions.sql):
-- a dismissed nudge reappears after reappear_at if still true.
CREATE TABLE public.tracker_nudge_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL REFERENCES public.product_categories(key) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('increase','decrease')),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  reappear_at timestamptz NOT NULL,
  UNIQUE (user_id, category, direction)
);

CREATE INDEX IF NOT EXISTS idx_tracker_nudge_dismissals_user_reappear_at
  ON public.tracker_nudge_dismissals (user_id, reappear_at);

CREATE TRIGGER set_updated_at_routine_logs
  BEFORE UPDATE ON public.routine_logs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.routine_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_log_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_nudge_dismissals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.routine_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.routine_log_products FROM anon, authenticated;
REVOKE ALL ON TABLE public.tracker_nudge_dismissals FROM anon, authenticated;

GRANT SELECT ON TABLE public.routine_logs TO authenticated;
GRANT SELECT ON TABLE public.routine_log_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tracker_nudge_dismissals TO authenticated;

GRANT ALL ON TABLE public.routine_logs TO service_role;
GRANT ALL ON TABLE public.routine_log_products TO service_role;
GRANT ALL ON TABLE public.tracker_nudge_dismissals TO service_role;

CREATE POLICY routine_logs_select_own
  ON public.routine_logs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY routine_log_products_select_own
  ON public.routine_log_products
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.routine_logs l
      WHERE l.id = routine_log_id
        AND l.user_id = auth.uid()
    )
  );

CREATE POLICY tracker_nudge_dismissals_select_own
  ON public.tracker_nudge_dismissals
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY tracker_nudge_dismissals_insert_own
  ON public.tracker_nudge_dismissals
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY tracker_nudge_dismissals_update_own
  ON public.tracker_nudge_dismissals
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY tracker_nudge_dismissals_delete_own
  ON public.tracker_nudge_dismissals
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
