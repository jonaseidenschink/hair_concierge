-- Docket rework R1 — the freemium Premium sheet's native PayPal button.
--
-- `paypal_checkout_intents.source` has carried a two-value CHECK since
-- `20260527_add_billing_subscriptions.sql` ('pricing_page', 'quiz_result_offer'). The
-- Premium sheet is the third checkout entry point — Stripe's `create-checkout-session`
-- already knows it as `premium_sheet` — and the source is what pins the sheet's PayPal
-- plan to the STANDARD price catalog server-side, so a launch-pricing flag can never
-- charge a sheet buyer a price the sheet did not show (T13 §11 F06).
--
-- Widening a CHECK is additive: every existing row still satisfies it, and nothing reads
-- the constraint. No data migration, no dependency on any other migration in this program.

ALTER TABLE paypal_checkout_intents
  DROP CONSTRAINT IF EXISTS paypal_checkout_intents_source_check;

ALTER TABLE paypal_checkout_intents
  ADD CONSTRAINT paypal_checkout_intents_source_check
  CHECK (source IN ('pricing_page', 'quiz_result_offer', 'premium_sheet'));
