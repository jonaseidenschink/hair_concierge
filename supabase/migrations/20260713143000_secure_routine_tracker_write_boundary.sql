-- Existing experimental databases may already have the permissive v1 grants.
-- Keep authenticated reads under RLS, but route all log mutations through the
-- validated, atomic RPC boundary.
ALTER FUNCTION public.replace_routine_log(date, text, text, text, jsonb, uuid, bigint)
  SECURITY DEFINER;
ALTER FUNCTION public.delete_routine_log(date, text, uuid, bigint)
  SECURITY DEFINER;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_log_products FROM authenticated;

DROP POLICY IF EXISTS routine_logs_insert_own ON public.routine_logs;
DROP POLICY IF EXISTS routine_logs_update_own ON public.routine_logs;
DROP POLICY IF EXISTS routine_logs_delete_own ON public.routine_logs;
DROP POLICY IF EXISTS routine_log_products_insert_own ON public.routine_log_products;
DROP POLICY IF EXISTS routine_log_products_update_own ON public.routine_log_products;
DROP POLICY IF EXISTS routine_log_products_delete_own ON public.routine_log_products;
