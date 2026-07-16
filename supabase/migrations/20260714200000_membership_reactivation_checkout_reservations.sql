CREATE TABLE membership_reactivation_checkout_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  checkout_attempt_id uuid NOT NULL,
  interval text NOT NULL CHECK (interval IN ('month', 'quarter', 'year')),
  return_destination text NOT NULL DEFAULT '/chat',
  provider text CHECK (provider IN ('stripe', 'paypal')),
  provider_reference text,
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN (
      'open',
      'provider_selected',
      'provider_created',
      'completed',
      'expired',
      'reconciliation_required'
    )
  ),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, checkout_attempt_id)
);

CREATE UNIQUE INDEX membership_reactivation_one_open_per_user
  ON membership_reactivation_checkout_reservations (user_id)
  WHERE status IN ('open', 'provider_selected', 'provider_created', 'reconciliation_required');

CREATE INDEX membership_reactivation_reservation_expiry
  ON membership_reactivation_checkout_reservations (expires_at)
  WHERE status IN ('open', 'provider_selected', 'provider_created');

ALTER TABLE membership_reactivation_checkout_reservations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION acquire_membership_reactivation_checkout(
  p_user_id uuid,
  p_checkout_attempt_id uuid,
  p_interval text,
  p_return_destination text
)
RETURNS membership_reactivation_checkout_reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reservation membership_reactivation_checkout_reservations;
BEGIN
  IF p_interval NOT IN ('month', 'quarter', 'year') THEN
    RAISE EXCEPTION 'invalid reactivation interval' USING ERRCODE = '22023';
  END IF;

  UPDATE membership_reactivation_checkout_reservations
  SET status = 'expired', updated_at = now()
  WHERE user_id = p_user_id
    AND status IN ('open', 'provider_selected', 'provider_created')
    AND expires_at <= now();

  SELECT * INTO reservation
  FROM membership_reactivation_checkout_reservations
  WHERE user_id = p_user_id
    AND checkout_attempt_id = p_checkout_attempt_id;

  IF FOUND THEN
    IF reservation.status IN ('expired', 'completed') THEN
      RAISE EXCEPTION 'reactivation checkout attempt is closed' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.interval <> p_interval OR reservation.return_destination <> p_return_destination THEN
      RAISE EXCEPTION 'reactivation checkout attempt parameters changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN reservation;
  END IF;

  SELECT * INTO reservation
  FROM membership_reactivation_checkout_reservations
  WHERE user_id = p_user_id
    AND status IN ('open', 'provider_selected', 'provider_created', 'reconciliation_required')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF reservation.interval <> p_interval OR reservation.return_destination <> p_return_destination THEN
      RAISE EXCEPTION 'membership reactivation checkout already in progress'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN reservation;
  END IF;

  BEGIN
    INSERT INTO membership_reactivation_checkout_reservations (
      user_id,
      checkout_attempt_id,
      interval,
      return_destination
    ) VALUES (
      p_user_id,
      p_checkout_attempt_id,
      p_interval,
      p_return_destination
    )
    RETURNING * INTO reservation;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO reservation
    FROM membership_reactivation_checkout_reservations
    WHERE user_id = p_user_id
      AND status IN ('open', 'provider_selected', 'provider_created', 'reconciliation_required')
    ORDER BY created_at ASC
    LIMIT 1;

    IF FOUND THEN
      IF reservation.interval <> p_interval OR reservation.return_destination <> p_return_destination THEN
        RAISE EXCEPTION 'membership reactivation checkout already in progress'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN reservation;
    END IF;

    RAISE EXCEPTION 'membership reactivation checkout already in progress'
      USING ERRCODE = 'P0001';
  END;

  RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION claim_membership_reactivation_checkout_provider(
  p_reservation_id uuid,
  p_user_id uuid,
  p_provider text
)
RETURNS membership_reactivation_checkout_reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reservation membership_reactivation_checkout_reservations;
BEGIN
  IF p_provider NOT IN ('stripe', 'paypal') THEN
    RAISE EXCEPTION 'invalid reactivation provider' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO reservation
  FROM membership_reactivation_checkout_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR (
    reservation.status <> 'reconciliation_required'
    AND reservation.expires_at <= now()
  ) THEN
    RAISE EXCEPTION 'reactivation checkout reservation expired' USING ERRCODE = 'P0001';
  END IF;
  IF reservation.status = 'reconciliation_required' AND reservation.provider IS NULL THEN
    RAISE EXCEPTION 'reactivation checkout reconciliation provider missing' USING ERRCODE = 'P0001';
  END IF;
  IF reservation.provider IS NOT NULL AND reservation.provider <> p_provider THEN
    RAISE EXCEPTION 'reactivation checkout provider already selected' USING ERRCODE = 'P0001';
  END IF;

  UPDATE membership_reactivation_checkout_reservations
  SET provider = p_provider,
      status = CASE WHEN status = 'open' THEN 'provider_selected' ELSE status END,
      updated_at = now()
  WHERE id = p_reservation_id
  RETURNING * INTO reservation;

  RETURN reservation;
END;
$$;

REVOKE ALL ON FUNCTION acquire_membership_reactivation_checkout(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_membership_reactivation_checkout_provider(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acquire_membership_reactivation_checkout(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION claim_membership_reactivation_checkout_provider(uuid, uuid, text) TO service_role;

COMMENT ON TABLE membership_reactivation_checkout_reservations IS
  'Atomic per-user guard and provider reconciliation ledger for expired-member checkout.';
