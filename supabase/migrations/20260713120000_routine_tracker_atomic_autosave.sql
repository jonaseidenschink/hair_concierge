-- Routine tracker autosave ordering and transactional write boundary.
ALTER TABLE public.routine_logs
  ADD COLUMN custom_activity_name text,
  ADD COLUMN client_session_id uuid,
  ADD COLUMN client_revision bigint,
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE public.routine_logs DROP CONSTRAINT routine_logs_day_type_check;
ALTER TABLE public.routine_logs
  ADD CONSTRAINT routine_logs_day_type_check
  CHECK (day_type IN ('wash', 'clarifying', 'treatment_only', 'styling_only', 'none', 'custom'));
ALTER TABLE public.routine_logs
  ADD CONSTRAINT routine_logs_custom_activity_check
  CHECK (
    (day_type = 'custom' AND char_length(btrim(coalesce(custom_activity_name, ''))) BETWEEN 1 AND 60)
    OR (day_type <> 'custom' AND custom_activity_name IS NULL)
  );

CREATE OR REPLACE FUNCTION public.replace_routine_log(
  p_logged_on date,
  p_timezone text,
  p_day_type text,
  p_custom_activity_name text,
  p_products jsonb,
  p_client_session_id uuid,
  p_client_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_log public.routine_logs%ROWTYPE;
  v_day jsonb;
  v_inserted boolean := false;
  v_inserted_rows integer;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated'); END IF;
  IF p_logged_on IS NULL OR p_timezone IS NULL OR p_day_type IS NULL OR p_client_session_id IS NULL OR p_client_revision IS NULL OR p_client_revision < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_date', 'error', 'Ungültige Eintrag-Daten.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone)
     OR p_logged_on > (now() AT TIME ZONE p_timezone)::date
     OR p_logged_on < (now() AT TIME ZONE p_timezone)::date - 7 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_date', 'error', 'Ungültiges Datum.');
  END IF;
  IF jsonb_typeof(coalesce(p_products, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_products', 'error', 'Ungültige Produktdaten.');
  END IF;
  IF p_day_type NOT IN ('wash', 'clarifying', 'treatment_only', 'styling_only', 'none', 'custom')
     OR (p_day_type = 'custom' AND char_length(btrim(coalesce(p_custom_activity_name, ''))) NOT BETWEEN 1 AND 60)
     OR (p_day_type <> 'custom' AND p_custom_activity_name IS NOT NULL)
     OR (p_day_type = 'none' AND jsonb_array_length(coalesce(p_products, '[]'::jsonb)) <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_activity', 'error', 'Ungültige Eintrag-Daten.');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(coalesce(p_products, '[]'::jsonb)) AS p(category text, user_product_usage_id uuid)
    WHERE p.category IS NULL OR NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.key = p.category)
  ) THEN RETURN jsonb_build_object('ok', false, 'code', 'unknown_category', 'error', 'Unbekannte Kategorie.'); END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(coalesce(p_products, '[]'::jsonb)) AS p(category text, user_product_usage_id uuid)
    WHERE p.user_product_usage_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.user_product_usage u
      WHERE u.id = p.user_product_usage_id AND u.user_id = v_user_id AND u.category = p.category
    )
  ) THEN RETURN jsonb_build_object('ok', false, 'code', 'foreign_product', 'error', 'Ungültige Produktreferenz.'); END IF;

  INSERT INTO public.routine_logs (user_id, logged_on, timezone, day_type, custom_activity_name, client_session_id, client_revision)
  VALUES (v_user_id, p_logged_on, p_timezone, p_day_type, CASE WHEN p_day_type = 'custom' THEN btrim(p_custom_activity_name) END, p_client_session_id, p_client_revision)
  ON CONFLICT (user_id, logged_on) DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;
  v_inserted := v_inserted_rows > 0;
  SELECT * INTO v_log FROM public.routine_logs WHERE user_id = v_user_id AND logged_on = p_logged_on FOR UPDATE;
  IF NOT v_inserted AND v_log.client_session_id = p_client_session_id AND v_log.client_revision >= p_client_revision THEN
    SELECT jsonb_build_object('loggedOn', v_log.logged_on, 'dayType', v_log.day_type, 'customActivityName', v_log.custom_activity_name, 'deletedAt', v_log.deleted_at, 'products', coalesce(jsonb_agg(jsonb_build_object('category', p.category, 'productName', p.product_name, 'userProductUsageId', p.user_product_usage_id)), '[]'::jsonb)) INTO v_day FROM public.routine_log_products p WHERE p.routine_log_id = v_log.id;
    RETURN jsonb_build_object('ok', true, 'code', 'stale_revision', 'day', v_day);
  END IF;
  UPDATE public.routine_logs SET timezone = p_timezone, day_type = p_day_type,
    custom_activity_name = CASE WHEN p_day_type = 'custom' THEN btrim(p_custom_activity_name) END,
    client_session_id = p_client_session_id, client_revision = p_client_revision, deleted_at = NULL
    WHERE id = v_log.id;
  DELETE FROM public.routine_log_products WHERE routine_log_id = v_log.id;
  INSERT INTO public.routine_log_products (routine_log_id, category, product_name, user_product_usage_id)
    SELECT v_log.id, p.category, p.product_name, p.user_product_usage_id
    FROM jsonb_to_recordset(coalesce(p_products, '[]'::jsonb)) AS p(category text, product_name text, user_product_usage_id uuid);
  SELECT jsonb_build_object('loggedOn', l.logged_on, 'dayType', l.day_type, 'customActivityName', l.custom_activity_name, 'deletedAt', l.deleted_at, 'products', coalesce(jsonb_agg(jsonb_build_object('category', p.category, 'productName', p.product_name, 'userProductUsageId', p.user_product_usage_id)) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb)) INTO v_day FROM public.routine_logs l LEFT JOIN public.routine_log_products p ON p.routine_log_id = l.id WHERE l.id = v_log.id GROUP BY l.id;
  RETURN jsonb_build_object('ok', true, 'code', 'saved', 'day', v_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_routine_log(p_logged_on date, p_timezone text, p_client_session_id uuid, p_client_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user_id uuid := auth.uid(); v_log public.routine_logs%ROWTYPE; v_day jsonb;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated'); END IF;
  IF p_logged_on IS NULL OR p_timezone IS NULL OR p_client_session_id IS NULL OR p_client_revision IS NULL OR p_client_revision < 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone)
     OR p_logged_on > (now() AT TIME ZONE p_timezone)::date
     OR p_logged_on < (now() AT TIME ZONE p_timezone)::date - 7 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_date', 'error', 'Ungültiges Datum.');
  END IF;
  SELECT * INTO v_log FROM public.routine_logs WHERE user_id = v_user_id AND logged_on = p_logged_on FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'code', 'deleted', 'day', jsonb_build_object('loggedOn', p_logged_on, 'deletedAt', now())); END IF;
  IF v_log.client_session_id = p_client_session_id AND v_log.client_revision >= p_client_revision THEN
    RETURN jsonb_build_object('ok', true, 'code', 'stale_revision', 'day', jsonb_build_object('loggedOn', v_log.logged_on, 'deletedAt', v_log.deleted_at));
  END IF;
  UPDATE public.routine_logs SET deleted_at = now(), client_session_id = p_client_session_id, client_revision = p_client_revision WHERE id = v_log.id RETURNING jsonb_build_object('loggedOn', logged_on, 'dayType', day_type, 'customActivityName', custom_activity_name, 'deletedAt', deleted_at, 'products', '[]'::jsonb) INTO v_day;
  DELETE FROM public.routine_log_products WHERE routine_log_id = v_log.id;
  RETURN jsonb_build_object('ok', true, 'code', 'deleted', 'day', v_day);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_routine_log(date, text, text, text, jsonb, uuid, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_routine_log(date, text, uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_routine_log(date, text, text, text, jsonb, uuid, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_routine_log(date, text, uuid, bigint) TO authenticated, service_role;
