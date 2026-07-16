import { z } from "zod"
import { SELECTABLE_PRODUCT_CATEGORIES } from "@/lib/agent/contracts"

export const AgentV2AnswerModeSchema = z.enum([
  "product_recommendation",
  "product_assessment",
  "routine",
  "general_advice",
  "clarification",
  "constraint_blocked",
  "safety_boundary",
  "social",
  "domain_boundary",
])

export type AgentV2AnswerMode = z.infer<typeof AgentV2AnswerModeSchema>

export const AgentV2RoutineLayerSchema = z.enum(["basics", "goals", "problems", "deep_dive"])

export type AgentV2RoutineLayer = z.infer<typeof AgentV2RoutineLayerSchema>

export const AgentV2SafetyModeSchema = z.enum(["normal", "restricted", "hard_short_circuit"])

export type AgentV2SafetyMode = z.infer<typeof AgentV2SafetyModeSchema>

export const AgentV2TurnGateStatusSchema = z.enum([
  "proceed",
  "social",
  "domain_boundary",
  "prompt_or_role_bypass",
])

export type AgentV2TurnGateStatus = z.infer<typeof AgentV2TurnGateStatusSchema>

export const AgentV2TurnGateBoundaryKindSchema = z.enum([
  "unsupported_domain",
  "prompt_or_role_bypass",
])

export type AgentV2TurnGateBoundaryKind = z.infer<typeof AgentV2TurnGateBoundaryKindSchema>

export const AgentV2TurnGateResultSchema = z.strictObject({
  gate_status: AgentV2TurnGateStatusSchema,
  evidence_quote: z.string().min(1),
  confidence: z.number().min(0).max(1),
  boundary_kind: AgentV2TurnGateBoundaryKindSchema.nullable(),
})

export type AgentV2TurnGateResult = z.infer<typeof AgentV2TurnGateResultSchema>

export const AgentV2TurnGateTraceSchema = z.strictObject({
  proposed: AgentV2TurnGateResultSchema.nullable(),
  authorized: AgentV2TurnGateResultSchema.nullable(),
  safety_mode: AgentV2SafetyModeSchema,
  advisor_continuation_allowed: z.boolean(),
  enabled: z.boolean(),
  latency_ms: z.number().nonnegative().nullable(),
})

export type AgentV2TurnGateTrace = z.infer<typeof AgentV2TurnGateTraceSchema>

export const AgentV2ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

export type AgentV2ReasoningEffort = z.infer<typeof AgentV2ReasoningEffortSchema>

export const AgentV2TextVerbositySchema = z.enum(["low", "medium", "high"])

export type AgentV2TextVerbosity = z.infer<typeof AgentV2TextVerbositySchema>

export const AgentV2PrimaryIntentSchema = z.enum([
  "product_recommendation",
  "category_education",
  "routine_build",
  "routine_mutation",
  "routine_explanation",
  "routine_exit",
  "general_advice",
  "clarification",
  "safety_boundary",
  "smalltalk",
  "unknown",
])

export type AgentV2PrimaryIntent = z.infer<typeof AgentV2PrimaryIntentSchema>

export const AgentV2ProductRequestKindSchema = z.enum([
  "none",
  "specific_products",
  "category_education",
  "compare_products",
  "product_detail",
])

export type AgentV2ProductRequestKind = z.infer<typeof AgentV2ProductRequestKindSchema>

export const AgentV2RoutineIntentSchema = z.enum([
  "none",
  "create",
  "modify",
  "remove_step",
  "replace_product",
  "explain",
  "summarize",
  "exit",
])

export type AgentV2RoutineIntent = z.infer<typeof AgentV2RoutineIntentSchema>

export const AgentV2CareCategorySchema = z.enum([
  "none",
  "unknown",
  "shampoo",
  "conditioner",
  "mask",
  "leave_in",
  "oil",
  "bondbuilder",
  "deep_cleansing_shampoo",
  "dry_shampoo",
  "peeling",
  "styling",
  "treatment",
])

export type AgentV2CareCategory = z.infer<typeof AgentV2CareCategorySchema>

export const AgentV2PendingFollowupKindSchema = z.enum([
  "product_recommendation",
  "advisor_response",
  "routine_mutation",
])

export type AgentV2PendingFollowupKind = z.infer<typeof AgentV2PendingFollowupKindSchema>

const AgentV2ConcreteProductFollowupCategorySchema = z.enum(SELECTABLE_PRODUCT_CATEGORIES)

const AgentV2PendingRoutineActionSchema = z.enum([
  "create",
  "modify",
  "add_step",
  "remove_step",
  "replace_product",
  "simplify",
])

export const AgentV2PendingFollowupActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("product_recommendation"),
    category: AgentV2ConcreteProductFollowupCategorySchema,
    routine_layer: z.null(),
    routine_action: z.null(),
    source: z.literal("assistant_offer"),
  }),
  z.strictObject({
    kind: z.literal("advisor_response"),
    category: AgentV2CareCategorySchema.nullable(),
    routine_layer: AgentV2RoutineLayerSchema.nullable(),
    routine_action: z.null(),
    source: z.literal("assistant_offer"),
  }),
  z.strictObject({
    kind: z.literal("routine_mutation"),
    category: AgentV2CareCategorySchema.nullable(),
    routine_layer: AgentV2RoutineLayerSchema.nullable(),
    routine_action: AgentV2PendingRoutineActionSchema,
    source: z.literal("assistant_offer"),
  }),
])

export type AgentV2PendingFollowupAction = z.infer<typeof AgentV2PendingFollowupActionSchema>

export const AgentV2CountPolicySchema = z.enum(["none", "exact", "default", "cap"])

export type AgentV2CountPolicy = z.infer<typeof AgentV2CountPolicySchema>

export const AgentV2RequestInterpretationSchema = z.strictObject({
  primary_intent: AgentV2PrimaryIntentSchema,
  product_request_kind: AgentV2ProductRequestKindSchema,
  routine_intent: AgentV2RoutineIntentSchema,
  care_category: AgentV2CareCategorySchema,
  requested_product_count: z.number().int().min(0).max(6).nullable(),
  count_policy: AgentV2CountPolicySchema,
  evidence_quote: z.string().min(1),
  specific_product_candidate: z.boolean(),
  confidence: z.number().min(0).max(1),
})

export type AgentV2RequestInterpretation = z.infer<typeof AgentV2RequestInterpretationSchema>

export const AgentV2MissingInformationSchema = z.strictObject({
  key: z.string(),
  label_de: z.string(),
  blocking: z.boolean(),
  question_de: z.string(),
})

export type AgentV2MissingInformation = z.infer<typeof AgentV2MissingInformationSchema>

export const AgentV2ExtractedConstraintsSchema = z.strictObject({
  hair_concerns: z.array(z.string()),
  goals: z.array(z.string()),
  product_categories: z.array(z.string()),
  budget_eur: z.number().nullable(),
  avoid_ingredients: z.array(z.string()),
  allergies: z.array(z.string()),
  preferences: z.array(z.string()),
  routine_layer: AgentV2RoutineLayerSchema.nullable(),
  raw_constraints: z.array(z.string()),
})

export type AgentV2ExtractedConstraints = z.infer<typeof AgentV2ExtractedConstraintsSchema>

export const AgentV2ToolGroundingSchema = z.strictObject({
  used_guidance_package_ids: z.array(z.string()),
  used_product_tool: z.boolean(),
  used_routine_tool: z.boolean(),
  product_ids: z.array(z.string()),
  routine_step_ids: z.array(z.string()),
  hard_rule_ids: z.array(z.string()),
})

export type AgentV2ToolGrounding = z.infer<typeof AgentV2ToolGroundingSchema>

export const AgentV2RoutineContextSchema = z.strictObject({
  active: z.boolean(),
  routine_layer: AgentV2RoutineLayerSchema.nullable(),
  step_id: z.string().nullable(),
  category: z.string().nullable(),
  return_path: z.array(z.string()),
})

export type AgentV2RoutineContext = z.infer<typeof AgentV2RoutineContextSchema>

export const AgentV2RoutineThreadStepSchema = z.strictObject({
  step_id: z.string(),
  label_de: z.string(),
  category: z.string().nullable(),
  action: z.enum(["keep", "add", "adjust", "remove"]).nullable().optional(),
  necessity: z.enum(["core", "recommended", "optional"]).nullable().optional(),
  already_in_current_routine: z.boolean().nullable().optional(),
  order: z.number().int().positive(),
  routine_layer: AgentV2RoutineLayerSchema.nullable(),
})

export type AgentV2RoutineThreadStep = z.infer<typeof AgentV2RoutineThreadStepSchema>

export const AgentV2RoutineThreadContextSchema = z.strictObject({
  active: z.boolean(),
  current_layer: AgentV2RoutineLayerSchema.nullable(),
  last_answer_mode: AgentV2AnswerModeSchema.nullable(),
  last_routine_categories: z.array(z.string()),
  last_user_goal: z.string().nullable(),
  summary_de: z.string().nullable(),
  pending_followup_action: AgentV2PendingFollowupActionSchema.nullable().optional(),
  visible_steps: z.array(AgentV2RoutineThreadStepSchema),
})

export type AgentV2RoutineThreadContext = z.infer<typeof AgentV2RoutineThreadContextSchema>

export const AgentV2SessionMemoryWriteSchema = z.strictObject({
  type: z.enum([
    "preference",
    "constraint",
    "routine_context",
    "product_feedback",
    "clarification",
    "other",
  ]),
  text: z.string(),
  evidence_quote: z.string(),
  confidence: z.number().min(0).max(1),
  ttl: z.literal("session"),
  affects_recommendations: z.boolean(),
  expires_at_turn: z.number().int().positive().nullable(),
})

export type AgentV2SessionMemoryWrite = z.infer<typeof AgentV2SessionMemoryWriteSchema>

const AgentV2RecommendationPayloadSchema = z.strictObject({
  product_id: z.string(),
  reason_de: z.string(),
  usage_de: z.string().nullable(),
  caveat_de: z.string().nullable(),
})

export const AgentV2ProductRecommendationPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  recommendations: z.array(AgentV2RecommendationPayloadSchema),
  comparison_notes_de: z.array(z.string()),
  usage_notes_de: z.array(z.string()),
  next_step_offer_de: z.string().nullable(),
})

export const AgentV2ProductAssessmentKindSchema = z.enum(["fit", "detail", "routine_usage"])

export type AgentV2ProductAssessmentKind = z.infer<typeof AgentV2ProductAssessmentKindSchema>

export const AgentV2ProductAssessmentPayloadSchema = z.strictObject({
  assessment_kind: AgentV2ProductAssessmentKindSchema.describe(
    "Type of single resolved-product assessment: fit, detail, or routine_usage. Product comparisons belong in product_recommendation/select_products, not product_assessment.",
  ),
  assessed_product_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(1)
    .describe(
      "The single verified product ID being assessed. Must come from lookup_product_candidate, selected clarification context, active resolved product context, or internal product facts for the resolved product.",
    ),
  user_facing_answer_de: z
    .string()
    .describe(
      "Complete German answer shown to the user. Include all assessment rationale and usage caveats here; product_assessment has no recommendations or usage_notes_de fields.",
    ),
})

export const AgentV2RoutineStepPayloadSchema = z.strictObject({
  step_id: z.string(),
  label_de: z.string(),
  action_de: z.string(),
  frequency_de: z.string().nullable(),
  reason_de: z.string(),
})

export const AgentV2RoutinePayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  routine_layer: AgentV2RoutineLayerSchema,
  visible_steps: z.array(AgentV2RoutineStepPayloadSchema),
  next_layer_options: z.array(AgentV2RoutineLayerSchema),
  next_step_offer_de: z.string().nullable(),
})

export const AgentV2GeneralAdvicePayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  category_or_topic: z.string(),
  key_points_de: z.array(z.string()),
  next_step_offer_de: z.string().nullable(),
})

export const AgentV2ClarificationPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  question_de: z.string(),
  missing_keys: z.array(z.string()),
})

export const AgentV2ConstraintBlockedPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  blocking_constraints: z.array(z.string()),
  safe_alternative_de: z.string().nullable(),
})

export const AgentV2SafetyBoundaryPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  boundary_reason_de: z.string(),
  next_step_de: z.string().nullable(),
})

export const AgentV2SocialPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  pivot_de: z.string().nullable(),
})

export const AgentV2DomainBoundaryPayloadSchema = z.strictObject({
  user_facing_answer_de: z.string(),
  boundary_kind: AgentV2TurnGateBoundaryKindSchema,
  redirect_topic_de: z.string().nullable(),
})

const AgentV2TerminalAnswerBaseSchema = z.strictObject({
  interpreted_intent: z.string(),
  request_interpretation: AgentV2RequestInterpretationSchema,
  confidence: z.number().min(0).max(1),
  extracted_constraints: AgentV2ExtractedConstraintsSchema,
  missing_information: z.array(AgentV2MissingInformationSchema),
  safety_flags: z.array(z.string()),
  tool_grounding: AgentV2ToolGroundingSchema,
  routine_context: AgentV2RoutineContextSchema,
  pending_followup_action: AgentV2PendingFollowupActionSchema.nullable(),
  session_memory_writes: z.array(AgentV2SessionMemoryWriteSchema),
})

export const AgentV2TerminalAnswerSchema = z.discriminatedUnion("answer_mode", [
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("product_recommendation"),
    payload: AgentV2ProductRecommendationPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("product_assessment"),
    payload: AgentV2ProductAssessmentPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("routine"),
    payload: AgentV2RoutinePayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("general_advice"),
    payload: AgentV2GeneralAdvicePayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("clarification"),
    payload: AgentV2ClarificationPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("constraint_blocked"),
    payload: AgentV2ConstraintBlockedPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("safety_boundary"),
    payload: AgentV2SafetyBoundaryPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("social"),
    payload: AgentV2SocialPayloadSchema,
  }),
  AgentV2TerminalAnswerBaseSchema.extend({
    answer_mode: z.literal("domain_boundary"),
    payload: AgentV2DomainBoundaryPayloadSchema,
  }),
])

export type AgentV2TerminalAnswer = z.infer<typeof AgentV2TerminalAnswerSchema>

export const AgentV2GuidanceRuleSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["block", "warn", "info"]),
  source: z.string(),
  validator_id: z.string().optional(),
  message: z.string(),
})

export type AgentV2GuidanceRule = z.infer<typeof AgentV2GuidanceRuleSchema>

export const AgentV2GuidanceSoftRubricSchema = z.object({
  rubric_id: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  source: z.string(),
  message: z.string(),
})

export type AgentV2GuidanceSoftRubric = z.infer<typeof AgentV2GuidanceSoftRubricSchema>

export const AgentV2RequiredGroundingSchema = z.object({
  grounding_id: z.string(),
  tool: z.string(),
  when: z.string(),
})

export type AgentV2RequiredGrounding = z.infer<typeof AgentV2RequiredGroundingSchema>

export const AgentV2AskWhenSchema = z.object({
  condition: z.string(),
  question_policy: z.string(),
})

export type AgentV2AskWhen = z.infer<typeof AgentV2AskWhenSchema>

export const AgentV2GuidancePackageSchema = z.object({
  package_id: z.string(),
  version: z.number().int().positive(),
  scope: z.object({
    answer_modes: z.array(AgentV2AnswerModeSchema),
    categories: z.array(z.string()),
    routine_layers: z.array(AgentV2RoutineLayerSchema),
    safety_modes: z.array(AgentV2SafetyModeSchema),
  }),
  hard_rules: z.array(AgentV2GuidanceRuleSchema),
  soft_rubrics: z.array(AgentV2GuidanceSoftRubricSchema),
  required_grounding: z.array(AgentV2RequiredGroundingSchema),
  ask_when: z.array(AgentV2AskWhenSchema),
  markdown_path: z.string(),
})

export type AgentV2GuidancePackage = z.infer<typeof AgentV2GuidancePackageSchema>

export const AgentV2LoadedGuidancePackageSchema = AgentV2GuidancePackageSchema.extend({
  markdown_brief: z.string(),
})

export type AgentV2LoadedGuidancePackage = z.infer<typeof AgentV2LoadedGuidancePackageSchema>

export const AgentV2ValidationErrorSchema = z.object({
  validator_id: z.string(),
  message: z.string(),
  severity: z.enum(["block", "warn"]).default("block"),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  reason_code: z.string().optional(),
  rejected_value: z.unknown().optional(),
  expected: z.unknown().optional(),
  suggested_value: z.unknown().optional(),
  repair_hint: z.string().optional(),
})

export type AgentV2ValidationError = z.infer<typeof AgentV2ValidationErrorSchema>

export const AgentV2DroppedSessionMemoryWriteSchema = z.object({
  validator_id: z.string(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  write: z.unknown(),
})

export type AgentV2DroppedSessionMemoryWrite = z.infer<
  typeof AgentV2DroppedSessionMemoryWriteSchema
>

export const AgentV2ToolCallTraceSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  output_summary: z.string().optional(),
  latency_ms: z.number().nonnegative().optional(),
})

export type AgentV2ToolCallTrace = z.infer<typeof AgentV2ToolCallTraceSchema>

export const AgentV2ModelStepTraceSchema = z.custom<unknown>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true
  const latencyMs = (value as { latency_ms?: unknown }).latency_ms
  return (
    latencyMs === undefined ||
    (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0)
  )
})

export type AgentV2ModelStepTrace = z.infer<typeof AgentV2ModelStepTraceSchema>

export const AgentV2TraceSchema = z.object({
  engine: z.literal("agent_v2"),
  model: z.string(),
  endpoint: z.literal("responses"),
  reasoning_effort: AgentV2ReasoningEffortSchema,
  safety_mode: AgentV2SafetyModeSchema,
  answer_mode: AgentV2AnswerModeSchema.nullable(),
  named_product_context: z
    .strictObject({
      display_name: z.string(),
      category: AgentV2CareCategorySchema,
    })
    .nullable()
    .default(null),
  response_ids: z.array(z.string()),
  model_steps: z.array(AgentV2ModelStepTraceSchema),
  tool_calls: z.array(AgentV2ToolCallTraceSchema),
  turn_gate: AgentV2TurnGateTraceSchema.nullable().optional(),
  tracker_context: z
    .object({
      load_status: z.enum(["available", "empty", "unavailable"]),
      load_reason: z.enum([
        "loaded",
        "no_entries",
        "missing_user",
        "query_failed",
        "unexpected_error",
      ]),
      logged_day_count: z.number().int().nonnegative(),
      insight_count: z.number().int().nonnegative(),
      load_ms: z.number().int().nonnegative(),
    })
    .optional(),
  blocked_tool_calls: z.array(
    z.object({
      name: z.string(),
      reason: z.string(),
    }),
  ),
  loaded_guidance_package_ids: z.array(z.string()),
  validation_errors: z.array(AgentV2ValidationErrorSchema),
  validation_warnings: z.array(AgentV2ValidationErrorSchema),
  request_interpretation: AgentV2RequestInterpretationSchema.nullable(),
  request_interpretation_summary: z.string().nullable(),
  bounded_repair_kind: z
    .enum([
      "terminal_only",
      "missing_guidance_or_tools",
      "missing_select_products",
      "missing_build_or_fix_routine",
      "unrepairable",
    ])
    .nullable(),
  repair_attempts: z.array(
    z.object({
      reason: z.string(),
      validation_errors: z.array(AgentV2ValidationErrorSchema),
    }),
  ),
  routine_thread_context_active: z.boolean(),
  routine_thread_context: AgentV2RoutineThreadContextSchema.nullable(),
  final_product_ids: z.array(z.string()),
  routine_layer: AgentV2RoutineLayerSchema.nullable(),
  session_memory_writes: z.array(AgentV2SessionMemoryWriteSchema),
  dropped_session_memory_writes: z.array(AgentV2DroppedSessionMemoryWriteSchema),
  injected_session_memory: z.array(AgentV2SessionMemoryWriteSchema),
  langfuse: z.object({
    enabled: z.boolean(),
    trace_id: z.string().nullable(),
    trace_url: z.string().nullable(),
  }),
  failure_stage: z
    .enum([
      "missing_terminal_answer",
      "multiple_terminal_answers",
      "terminal_with_other_tool_calls",
      "invalid_json",
      "tool_not_allowed",
      "max_model_steps",
      "max_executable_tool_calls",
      "validation_failed",
      "repair_failed",
      "missing_terminal_failed",
      "turn_gate_failed",
    ])
    .nullable(),
})

export type AgentV2Trace = z.infer<typeof AgentV2TraceSchema>
