ALTER TABLE paypal_checkout_intents
  ADD COLUMN reactivation_reservation_id uuid
  REFERENCES membership_reactivation_checkout_reservations (id)
  ON DELETE SET NULL;

WITH ranked_intents AS (
  SELECT
    intent.id,
    reservation.id AS reservation_id,
    row_number() OVER (
      PARTITION BY reservation.id
      ORDER BY
        CASE intent.status
          WHEN 'activated' THEN 0
          WHEN 'approved' THEN 1
          WHEN 'created' THEN 2
          ELSE 3
        END,
        intent.created_at ASC,
        intent.id ASC
    ) AS reservation_rank
  FROM paypal_checkout_intents AS intent
  JOIN membership_reactivation_checkout_reservations AS reservation
    ON intent.metadata ->> 'reactivation_reservation_id' = reservation.id::text
  WHERE intent.reactivation_reservation_id IS NULL
), canonical_intents AS (
  SELECT id, reservation_id
  FROM ranked_intents
  WHERE reservation_rank = 1
), duplicate_intents AS (
  SELECT id
  FROM ranked_intents
  WHERE reservation_rank > 1
), mark_duplicates AS (
  UPDATE paypal_checkout_intents AS intent
  SET status = 'duplicate',
      duplicate_reason = 'reactivation_reservation_race',
      metadata = intent.metadata || jsonb_build_object(
        'reactivation_reservation_duplicate_ignored', true
      ),
      updated_at = now()
  FROM duplicate_intents
  WHERE intent.id = duplicate_intents.id
  RETURNING intent.id
)
UPDATE paypal_checkout_intents AS intent
SET reactivation_reservation_id = canonical_intents.reservation_id
FROM canonical_intents
WHERE intent.id = canonical_intents.id;

CREATE UNIQUE INDEX paypal_checkout_intents_one_per_reactivation_reservation
  ON paypal_checkout_intents (reactivation_reservation_id)
  WHERE reactivation_reservation_id IS NOT NULL;

COMMENT ON COLUMN paypal_checkout_intents.reactivation_reservation_id IS
  'Canonical membership reactivation reservation; at most one PayPal checkout intent may own it.';
