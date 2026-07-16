CREATE TABLE billing_subscription_plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE,
  billing_subscription_id uuid NOT NULL REFERENCES billing_subscriptions (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  current_interval text NOT NULL CHECK (current_interval IN ('month', 'quarter', 'year')),
  target_interval text NOT NULL CHECK (target_interval IN ('month', 'quarter', 'year')),
  effective_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending_provider', 'pending_approval', 'scheduled', 'reconciling', 'applied', 'failed')
  ),
  provider_resource_id text,
  provider_target_id text,
  approved_at timestamptz,
  applied_at timestamptz,
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_interval <> target_interval)
);

CREATE UNIQUE INDEX billing_plan_change_one_open_per_subscription
  ON billing_subscription_plan_changes (billing_subscription_id)
  WHERE status IN ('pending_provider', 'pending_approval', 'scheduled', 'reconciling');

CREATE INDEX billing_plan_change_user_created
  ON billing_subscription_plan_changes (user_id, created_at DESC);

ALTER TABLE billing_subscription_plan_changes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION claim_billing_subscription_plan_change(
  p_operation_id uuid,
  p_billing_subscription_id uuid,
  p_user_id uuid,
  p_provider text,
  p_current_interval text,
  p_target_interval text,
  p_effective_at timestamptz
)
RETURNS billing_subscription_plan_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  operation billing_subscription_plan_changes;
BEGIN
  IF p_provider NOT IN ('stripe', 'paypal')
     OR p_current_interval NOT IN ('month', 'quarter', 'year')
     OR p_target_interval NOT IN ('month', 'quarter', 'year')
     OR p_current_interval = p_target_interval THEN
    RAISE EXCEPTION 'invalid subscription plan change' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO operation
  FROM billing_subscription_plan_changes
  WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF operation.billing_subscription_id <> p_billing_subscription_id
       OR operation.user_id <> p_user_id
       OR operation.provider <> p_provider
       OR operation.current_interval <> p_current_interval
       OR operation.target_interval <> p_target_interval THEN
      RAISE EXCEPTION 'plan change operation parameters changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN operation;
  END IF;

  BEGIN
    INSERT INTO billing_subscription_plan_changes (
      operation_id,
      billing_subscription_id,
      user_id,
      provider,
      current_interval,
      target_interval,
      effective_at,
      status
    ) VALUES (
      p_operation_id,
      p_billing_subscription_id,
      p_user_id,
      p_provider,
      p_current_interval,
      p_target_interval,
      p_effective_at,
      'pending_provider'
    ) RETURNING * INTO operation;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO operation
    FROM billing_subscription_plan_changes
    WHERE operation_id = p_operation_id;

    IF FOUND THEN RETURN operation; END IF;
    RAISE EXCEPTION 'another subscription plan change is already pending' USING ERRCODE = 'P0001';
  END;

  RETURN operation;
END;
$$;

CREATE OR REPLACE FUNCTION advance_billing_subscription_plan_change(
  p_operation_id uuid,
  p_expected_status text,
  p_status text,
  p_provider_resource_id text DEFAULT NULL,
  p_provider_target_id text DEFAULT NULL,
  p_effective_at timestamptz DEFAULT NULL,
  p_failure_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS billing_subscription_plan_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  operation billing_subscription_plan_changes;
BEGIN
  IF p_status NOT IN ('pending_provider', 'pending_approval', 'scheduled', 'reconciling', 'applied', 'failed') THEN
    RAISE EXCEPTION 'invalid plan change status' USING ERRCODE = '22023';
  END IF;

  UPDATE billing_subscription_plan_changes
  SET status = p_status,
      provider_resource_id = COALESCE(p_provider_resource_id, provider_resource_id),
      provider_target_id = COALESCE(p_provider_target_id, provider_target_id),
      effective_at = COALESCE(p_effective_at, effective_at),
      approved_at = CASE
        WHEN p_status IN ('scheduled', 'reconciling', 'applied') THEN COALESCE(approved_at, now())
        ELSE approved_at
      END,
      applied_at = CASE WHEN p_status = 'applied' THEN COALESCE(applied_at, now()) ELSE applied_at END,
      failure_code = CASE
        WHEN p_status IN ('failed', 'reconciling') THEN p_failure_code
        ELSE failure_code
      END,
      metadata = metadata || COALESCE(p_metadata, '{}'::jsonb),
      updated_at = now()
  WHERE operation_id = p_operation_id
    AND status = p_expected_status
  RETURNING * INTO operation;

  IF FOUND THEN RETURN operation; END IF;

  SELECT * INTO operation
  FROM billing_subscription_plan_changes
  WHERE operation_id = p_operation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan change operation not found' USING ERRCODE = 'P0001';
  END IF;

  IF operation.status = p_status THEN RETURN operation; END IF;
  RAISE EXCEPTION 'plan change operation status conflict' USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION claim_billing_subscription_plan_change(uuid, uuid, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_billing_subscription_plan_change(uuid, text, text, text, text, timestamptz, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_billing_subscription_plan_change(uuid, uuid, uuid, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION advance_billing_subscription_plan_change(uuid, text, text, text, text, timestamptz, text, jsonb) TO service_role;

COMMENT ON TABLE billing_subscription_plan_changes IS
  'Atomic idempotency and reconciliation ledger for next-renewal provider plan changes.';
