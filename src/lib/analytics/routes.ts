import type { AppEventName } from "./events"

type AppEventRoute = {
  customerio: boolean
  meta: boolean
  posthog: boolean
}

export const eventRoutes = {
  chat_product_recommendation_shown: { customerio: true, meta: false, posthog: true },
  checkout_start_failed: { customerio: false, meta: false, posthog: true },
  checkout_started: { customerio: true, meta: true, posthog: true },
  first_chat_message: { customerio: true, meta: false, posthog: true },
  onboarding_completed: { customerio: true, meta: false, posthog: true },
  offer_checkout_opened: { customerio: false, meta: false, posthog: true },
  offer_cta_clicked: { customerio: false, meta: false, posthog: true },
  offer_faq_opened: { customerio: false, meta: false, posthog: true },
  offer_payment_method_selected: { customerio: false, meta: false, posthog: true },
  offer_plan_selected: { customerio: false, meta: false, posthog: true },
  offer_section_viewed: { customerio: false, meta: false, posthog: true },
  offer_viewed: { customerio: false, meta: false, posthog: true },
  pricing_viewed: { customerio: true, meta: true, posthog: true },
  purchase_completed: { customerio: false, meta: true, posthog: false },
  quiz_completed: { customerio: true, meta: true, posthog: true },
  quiz_goals_selected: { customerio: true, meta: false, posthog: true },
  quiz_lead_captured: { customerio: false, meta: true, posthog: true },
  quiz_started: { customerio: true, meta: true, posthog: true },
  quiz_step_viewed: { customerio: true, meta: true, posthog: true },
  subscription_started: { customerio: false, meta: true, posthog: false },
} satisfies Record<AppEventName, AppEventRoute>
