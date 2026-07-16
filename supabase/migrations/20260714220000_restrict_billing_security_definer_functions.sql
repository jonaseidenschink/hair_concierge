-- Supabase grants function execution to API roles through default privileges.
-- These SECURITY DEFINER functions are server-only coordination primitives and
-- must only be callable with the service role.

REVOKE ALL ON FUNCTION acquire_membership_reactivation_checkout(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_membership_reactivation_checkout_provider(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_billing_subscription_plan_change(uuid, uuid, uuid, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION advance_billing_subscription_plan_change(uuid, text, text, text, text, timestamptz, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION acquire_membership_reactivation_checkout(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION claim_membership_reactivation_checkout_provider(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION claim_billing_subscription_plan_change(uuid, uuid, uuid, text, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION advance_billing_subscription_plan_change(uuid, text, text, text, text, timestamptz, text, jsonb)
  TO service_role;
