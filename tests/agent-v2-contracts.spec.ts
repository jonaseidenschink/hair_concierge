import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  AgentV2ValidationErrorSchema,
  AgentV2RequestInterpretationSchema,
  AgentV2RoutineThreadContextSchema,
  AgentV2TerminalAnswerSchema,
  AgentV2TraceSchema,
  type AgentV2RequestInterpretation,
  type AgentV2TerminalAnswer,
} from "../src/lib/agent-v2/contracts"
import { DEFAULT_AGENT_V2_MODEL, getAgentV2ModelPolicy } from "../src/lib/agent-v2/model-policy"

function emptyExtractedConstraints() {
  return {
    hair_concerns: [],
    goals: [],
    product_categories: [],
    budget_eur: null,
    avoid_ingredients: [],
    allergies: [],
    preferences: [],
    routine_layer: null,
    raw_constraints: [],
  }
}

function requestInterpretation(
  overrides: Partial<AgentV2RequestInterpretation> = {},
): AgentV2RequestInterpretation {
  return {
    primary_intent: "general_advice",
    product_request_kind: "none",
    routine_intent: "none",
    care_category: "none",
    requested_product_count: null,
    count_policy: "none",
    evidence_quote: "Brauche ich wirklich eine Maske?",
    specific_product_candidate: false,
    confidence: 0.9,
    ...overrides,
  }
}

test("AgentV2RequestInterpretationSchema accepts strict semantic examples", () => {
  const examples = [
    requestInterpretation({
      primary_intent: "product_recommendation",
      product_request_kind: "specific_products",
      care_category: "shampoo",
      requested_product_count: 2,
      count_policy: "exact",
      evidence_quote: "Empfiehl mir zwei Shampoos.",
    }),
    requestInterpretation({
      primary_intent: "product_recommendation",
      product_request_kind: "product_detail",
      care_category: "conditioner",
      requested_product_count: 1,
      count_policy: "exact",
      evidence_quote: "Was hältst du von meinem Jean & Len Conditioner?",
      specific_product_candidate: true,
    }),
    requestInterpretation({
      primary_intent: "category_education",
      product_request_kind: "category_education",
      care_category: "mask",
      count_policy: "none",
      evidence_quote: "Brauche ich wirklich eine Maske?",
    }),
    requestInterpretation({
      primary_intent: "routine_mutation",
      routine_intent: "replace_product",
      care_category: "conditioner",
      evidence_quote: "Tausch den Conditioner aus.",
    }),
    requestInterpretation({
      primary_intent: "routine_exit",
      routine_intent: "exit",
      evidence_quote: "Zurueck zur normalen Beratung.",
    }),
    requestInterpretation({
      primary_intent: "general_advice",
      care_category: "oil",
      evidence_quote: "Wie verwende ich Haaroel?",
    }),
    requestInterpretation({
      primary_intent: "clarification",
      care_category: "unknown",
      confidence: 0.42,
      evidence_quote: "Was soll ich nehmen?",
    }),
    requestInterpretation({
      primary_intent: "safety_boundary",
      care_category: "none",
      confidence: 0.98,
      evidence_quote: "Meine Kopfhaut blutet.",
    }),
    requestInterpretation({
      primary_intent: "smalltalk",
      confidence: 0.86,
      evidence_quote: "hallo",
    }),
    requestInterpretation({
      primary_intent: "unknown",
      confidence: 0.88,
      evidence_quote: "welchen nagellack soll ich kaufen?",
    }),
  ]

  for (const example of examples) {
    assert.deepEqual(AgentV2RequestInterpretationSchema.parse(example), example)
  }
})

test("AgentV2ValidationErrorSchema accepts optional repair metadata", () => {
  const parsed = AgentV2ValidationErrorSchema.parse({
    validator_id: "request_interpretation_evidence",
    message: "Evidence quote is not grounded.",
    severity: "block",
    path: ["request_interpretation", "evidence_quote"],
    reason_code: "evidence_quote_not_in_context",
    rejected_value: "Frizz repair",
    expected: "Exact phrase from latest user message or active context.",
    suggested_value: "Was hilft gegen Frizz bei meinem Haarprofil?",
    repair_hint: "Use suggested_value exactly for request_interpretation.evidence_quote.",
  })

  assert.equal(parsed.reason_code, "evidence_quote_not_in_context")
  assert.equal(parsed.rejected_value, "Frizz repair")
  assert.equal(parsed.suggested_value, "Was hilft gegen Frizz bei meinem Haarprofil?")
})

test("AgentV2RequestInterpretationSchema requires every semantic field", () => {
  const complete = requestInterpretation()

  for (const key of Object.keys(complete)) {
    const candidate = { ...complete } as Record<string, unknown>
    delete candidate[key]

    assert.equal(
      AgentV2RequestInterpretationSchema.safeParse(candidate).success,
      false,
      `expected missing ${key} to fail`,
    )
  }
})

test("AgentV2RequestInterpretationSchema rejects unknown enum values", () => {
  const result = AgentV2RequestInterpretationSchema.safeParse({
    ...requestInterpretation(),
    primary_intent: "buy_products",
  })

  assert.equal(result.success, false)
})

test("AgentV2RequestInterpretationSchema requires boolean product candidate signal", () => {
  const missing = { ...requestInterpretation() } as Record<string, unknown>
  delete missing.specific_product_candidate

  assert.equal(AgentV2RequestInterpretationSchema.safeParse(missing).success, false)

  const invalid = {
    ...requestInterpretation(),
    specific_product_candidate: "true",
  }

  assert.equal(AgentV2RequestInterpretationSchema.safeParse(invalid).success, false)
})

test("AgentV2RoutineThreadContextSchema accepts visible routine steps", () => {
  const context = {
    active: true,
    current_layer: "basics",
    last_answer_mode: "routine",
    last_routine_categories: ["shampoo", "conditioner", "leave_in"],
    last_user_goal: "Ich will meine Routine einfacher machen.",
    summary_de: "Klar - wir halten sie schlank.",
    visible_steps: [
      {
        step_id: "base-shampoo",
        label_de: "Shampoo",
        category: "shampoo",
        order: 1,
        routine_layer: "basics",
      },
      {
        step_id: "base-conditioner",
        label_de: "Conditioner",
        category: "conditioner",
        order: 2,
        routine_layer: "basics",
      },
    ],
  }

  assert.deepEqual(AgentV2RoutineThreadContextSchema.parse(context), context)
})

test("AgentV2TerminalAnswerSchema accepts a product recommendation payload", () => {
  const value: AgentV2TerminalAnswer = {
    answer_mode: "product_recommendation",
    interpreted_intent: "User wants a concrete shampoo recommendation.",
    request_interpretation: requestInterpretation({
      primary_intent: "product_recommendation",
      product_request_kind: "specific_products",
      care_category: "shampoo",
      requested_product_count: 1,
      count_policy: "default",
      evidence_quote: "Ich brauche ein Shampoo.",
    }),
    confidence: 0.93,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: ["base.product_recommendation.v1"],
      used_product_tool: true,
      used_routine_tool: false,
      product_ids: ["prod_1"],
      routine_step_ids: [],
      hard_rule_ids: ["product.no_uncatalogued_products"],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    pending_followup_action: null,
    session_memory_writes: [],
    payload: {
      user_facing_answer_de: "Ich würde dir dieses Shampoo empfehlen.",
      recommendations: [
        {
          product_id: "prod_1",
          reason_de: "Passt zu deinem feinen Haar und deiner schnell fettenden Kopfhaut.",
          usage_de: null,
          caveat_de: null,
        },
      ],
      comparison_notes_de: [],
      usage_notes_de: ["Shampoo vor allem am Ansatz verwenden und gründlich ausspülen."],
      next_step_offer_de: null,
    },
  }

  assert.equal(AgentV2TerminalAnswerSchema.parse(value).answer_mode, "product_recommendation")
})

test("AgentV2TerminalAnswerSchema accepts text-only product assessment payload", () => {
  const value = {
    answer_mode: "product_assessment",
    interpreted_intent: "User asks whether a named shampoo suits them.",
    request_interpretation: requestInterpretation({
      primary_intent: "product_recommendation",
      product_request_kind: "product_detail",
      care_category: "shampoo",
      requested_product_count: 1,
      count_policy: "exact",
      evidence_quote: "Passt Syoss Volume Shampoo zu mir?",
      specific_product_candidate: true,
    }),
    confidence: 0.91,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: ["base.product_recommendation.v1", "category.shampoo.v1"],
      used_product_tool: true,
      used_routine_tool: false,
      product_ids: ["prod_syoss_volume"],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    pending_followup_action: null,
    session_memory_writes: [],
    payload: {
      assessment_kind: "fit",
      assessed_product_ids: ["prod_syoss_volume"],
      user_facing_answer_de:
        "Danke fürs Auswählen. Syoss Volume Shampoo kann zu feinem Haar passen, wenn es am Ansatz gut reinigt und die Längen nicht beschwert.",
    },
  }

  assert.equal(AgentV2TerminalAnswerSchema.parse(value).answer_mode, "product_assessment")
})

test("AgentV2TerminalAnswerSchema rejects product assessment with too many products", () => {
  const result = AgentV2TerminalAnswerSchema.safeParse({
    answer_mode: "product_assessment",
    interpreted_intent: "User asks to compare too many named products.",
    request_interpretation: requestInterpretation({
      primary_intent: "product_recommendation",
      product_request_kind: "compare_products",
      care_category: "shampoo",
      requested_product_count: 4,
      count_policy: "exact",
      evidence_quote: "Vergleiche diese vier Shampoos.",
      specific_product_candidate: true,
    }),
    confidence: 0.88,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: ["base.product_recommendation.v1", "category.shampoo.v1"],
      used_product_tool: true,
      used_routine_tool: false,
      product_ids: ["p1", "p2", "p3", "p4"],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    pending_followup_action: null,
    session_memory_writes: [],
    payload: {
      assessment_kind: "comparison",
      assessed_product_ids: ["p1", "p2", "p3", "p4"],
      user_facing_answer_de: "Bitte grenze es auf maximal drei Produkte ein.",
    },
  })

  assert.equal(result.success, false)
})

test("AgentV2 terminal answer supports generalized pending follow-up action", () => {
  const parsed = AgentV2TerminalAnswerSchema.parse({
    answer_mode: "general_advice",
    interpreted_intent: "User asks whether they want product suggestions next.",
    request_interpretation: requestInterpretation({
      primary_intent: "category_education",
      product_request_kind: "category_education",
      care_category: "mask",
      evidence_quote: "Maske",
    }),
    confidence: 0.9,
    extracted_constraints: {
      ...emptyExtractedConstraints(),
      product_categories: ["mask"],
      raw_constraints: ["Maske"],
    },
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: [
        "base.advisor_rules.v1",
        "base.answer_contract.v1",
        "base.tone_and_format.v1",
        "base.general_advice.v1",
        "category.mask.v1",
      ],
      used_product_tool: false,
      used_routine_tool: false,
      product_ids: [],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: true,
      routine_layer: "basics",
      step_id: null,
      category: "mask",
      return_path: ["routine"],
    },
    pending_followup_action: {
      kind: "product_recommendation",
      category: "mask",
      routine_layer: null,
      routine_action: null,
      source: "assistant_offer",
    },
    session_memory_writes: [],
    payload: {
      user_facing_answer_de: "Eine Maske kann als Zusatz sinnvoll sein.",
      category_or_topic: "mask",
      key_points_de: ["Maske ist ein optionaler Zusatz."],
      next_step_offer_de: "Ich kann dir danach konkrete Masken empfehlen.",
    },
  })

  assert.equal(parsed.pending_followup_action?.kind, "product_recommendation")
})

test("AgentV2TerminalAnswerSchema accepts social and domain-boundary payloads", () => {
  const social: AgentV2TerminalAnswer = {
    answer_mode: "social",
    interpreted_intent: "User greets Chaarlie.",
    request_interpretation: requestInterpretation({
      primary_intent: "smalltalk",
      evidence_quote: "hallo",
      confidence: 0.9,
    }),
    confidence: 0.9,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: [
        "base.advisor_rules.v1",
        "base.answer_contract.v1",
        "base.tone_and_format.v1",
      ],
      used_product_tool: false,
      used_routine_tool: false,
      product_ids: [],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    pending_followup_action: null,
    session_memory_writes: [],
    payload: {
      user_facing_answer_de: "Hallo! Ich bin da, wenn du eine Haarfrage hast.",
      pivot_de: "Haarfrage",
    },
  }

  const boundary: AgentV2TerminalAnswer = {
    ...social,
    answer_mode: "domain_boundary",
    interpreted_intent: "User asks outside the supported hair-care domain.",
    request_interpretation: requestInterpretation({
      primary_intent: "unknown",
      evidence_quote: "welchen nagellack soll ich kaufen?",
      confidence: 0.9,
    }),
    payload: {
      user_facing_answer_de:
        "Bei Nagellack kann ich dir nicht sinnvoll helfen. Ich unterstütze dich gern bei Haarpflege, Kopfhaut, Styling oder passenden Produkten.",
      boundary_kind: "unsupported_domain",
      redirect_topic_de: "Haarpflege, Kopfhaut, Styling oder passende Produkte",
    },
  }

  assert.equal(AgentV2TerminalAnswerSchema.parse(social).answer_mode, "social")
  assert.equal(AgentV2TerminalAnswerSchema.parse(boundary).answer_mode, "domain_boundary")
})

test("AgentV2TraceSchema accepts turn-gate trace fields", () => {
  const trace = AgentV2TraceSchema.parse({
    engine: "agent_v2",
    model: DEFAULT_AGENT_V2_MODEL,
    endpoint: "responses",
    reasoning_effort: "low",
    safety_mode: "normal",
    answer_mode: "social",
    named_product_context: null,
    response_ids: [],
    model_steps: [],
    tool_calls: [],
    turn_gate: {
      proposed: {
        gate_status: "social",
        evidence_quote: "hallo",
        confidence: 0.9,
        boundary_kind: null,
      },
      authorized: {
        gate_status: "social",
        evidence_quote: "hallo",
        confidence: 0.9,
        boundary_kind: null,
      },
      safety_mode: "normal",
      advisor_continuation_allowed: false,
      enabled: true,
      latency_ms: 12,
    },
    tracker_context: {
      load_status: "unavailable",
      load_reason: "query_failed",
      logged_day_count: 0,
      insight_count: 0,
      load_ms: 4,
    },
    blocked_tool_calls: [],
    loaded_guidance_package_ids: [],
    validation_errors: [],
    validation_warnings: [],
    request_interpretation: null,
    request_interpretation_summary: null,
    bounded_repair_kind: null,
    repair_attempts: [],
    routine_thread_context_active: false,
    routine_thread_context: null,
    final_product_ids: [],
    routine_layer: null,
    session_memory_writes: [],
    dropped_session_memory_writes: [],
    injected_session_memory: [],
    langfuse: { enabled: false, trace_id: null, trace_url: null },
    failure_stage: null,
  })

  assert.equal(trace.turn_gate?.authorized?.gate_status, "social")
})

test("AgentV2TerminalAnswerSchema requires request interpretation", () => {
  const result = AgentV2TerminalAnswerSchema.safeParse({
    answer_mode: "general_advice",
    interpreted_intent: "User asks for category advice.",
    confidence: 0.9,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: [],
      used_product_tool: false,
      used_routine_tool: false,
      product_ids: [],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    session_memory_writes: [],
    payload: {
      user_facing_answer_de: "Eine Maske ist optional.",
      category_or_topic: "mask",
      key_points_de: ["Sie hilft bei zusätzlichem Pflegebedarf."],
      next_step_offer_de: null,
    },
  })

  assert.equal(result.success, false)
})

test("AgentV2TerminalAnswerSchema rejects unsupported answer modes", () => {
  const result = AgentV2TerminalAnswerSchema.safeParse({
    answer_mode: "random",
    interpreted_intent: "x",
    request_interpretation: requestInterpretation(),
    confidence: 0.5,
    extracted_constraints: emptyExtractedConstraints(),
    missing_information: [],
    safety_flags: [],
    tool_grounding: {
      used_guidance_package_ids: [],
      used_product_tool: false,
      used_routine_tool: false,
      product_ids: [],
      routine_step_ids: [],
      hard_rule_ids: [],
    },
    routine_context: {
      active: false,
      routine_layer: null,
      step_id: null,
      category: null,
      return_path: [],
    },
    session_memory_writes: [],
    payload: {},
  })

  assert.equal(result.success, false)
})

test("AgentV2 model policy defaults to GPT-5.4-mini Responses", () => {
  const policy = getAgentV2ModelPolicy({})
  assert.equal(policy.endpoint, "responses")
  assert.equal(DEFAULT_AGENT_V2_MODEL, "gpt-5.4-mini-2026-03-17")
  assert.equal(policy.model, DEFAULT_AGENT_V2_MODEL)
  assert.equal(policy.reasoning_effort, "low")
  assert.equal(policy.text_verbosity, "low")
  assert.equal(policy.store, false)
  assert.equal(policy.turn_gate_enabled, false)
})

test("AgentV2 model policy accepts scoped env overrides", () => {
  const policy = getAgentV2ModelPolicy({
    AGENT_V2_MODEL: "gpt-5.4-mini",
    AGENT_V2_REASONING_EFFORT: "medium",
    AGENT_V2_TEXT_VERBOSITY: "medium",
    AGENT_V2_TURN_GATE_ENABLED: "true",
  })

  assert.equal(policy.model, "gpt-5.4-mini")
  assert.equal(policy.reasoning_effort, "medium")
  assert.equal(policy.text_verbosity, "medium")
  assert.equal(policy.turn_gate_enabled, true)
})

test("AgentV2 model policy preserves minimal reasoning effort", () => {
  const policy = getAgentV2ModelPolicy({
    AGENT_V2_REASONING_EFFORT: "minimal",
  })

  assert.equal(policy.reasoning_effort, "minimal")
})

test("AgentV2 positive reference cases preserve quality shape rather than exact wording", () => {
  const cases = JSON.parse(
    readFileSync("data/agent-v2/evals/positive-reference-cases.json", "utf8"),
  ) as Array<Record<string, unknown>>

  assert.ok(cases.length >= 4)
  for (const entry of cases) {
    assert.equal(typeof entry.id, "string")
    assert.equal(entry.source, "manual_review")
    assert.ok(typeof entry.prompt === "string" || Array.isArray(entry.turns))
    assert.equal(typeof entry.positive_feedback_note, "string")
    assert.ok(Array.isArray(entry.qualities_to_preserve))
    assert.equal(entry.requires_textual_match, false)
  }

  const qualities = new Set(
    cases.flatMap((entry) =>
      Array.isArray(entry.qualities_to_preserve)
        ? entry.qualities_to_preserve.filter(
            (quality): quality is string => typeof quality === "string",
          )
        : [],
    ),
  )

  for (const expectedQuality of [
    "product recommendation fulfilled",
    "explicit count respected",
    "direct answer first",
    "profile-linked why",
    "category education first",
    "no forced product recommendation",
  ]) {
    assert.ok(
      qualities.has(expectedQuality),
      `missing positive reference quality: ${expectedQuality}`,
    )
  }
})

test("AgentV2 request interpretation regression fixture is structurally valid", () => {
  const cases = JSON.parse(
    readFileSync("data/agent-v2/evals/request-interpretation-regression.json", "utf8"),
  ) as Array<Record<string, unknown>>

  const primaryIntents = new Set([
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
  const productRequestKinds = new Set([
    "none",
    "specific_products",
    "category_education",
    "compare_products",
    "product_detail",
  ])
  const routineIntents = new Set([
    "none",
    "create",
    "modify",
    "remove_step",
    "replace_product",
    "explain",
    "summarize",
    "exit",
  ])
  const careCategories = new Set([
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
  const countPolicies = new Set(["none", "exact", "default", "cap"])
  const toolRequirements = new Set(["none", "select_products", "build_or_fix_routine"])
  const answerQualityCriteria = new Set([
    "direct_german_answer_first",
    "no_raw_internal_or_tool_language",
    "no_bullet_wall",
    "use_profile_or_context_when_available",
    "practical_next_step_or_caveat",
  ])

  assert.ok(cases.length >= 20)

  for (const entry of cases) {
    assert.equal(typeof entry.id, "string")
    assert.ok(
      typeof entry.prompt === "string" || Array.isArray(entry.turns),
      `${entry.id}: missing prompt or turns`,
    )
    assert.equal(typeof entry.description, "string")

    const expected = entry.expected as Record<string, unknown>
    assert.equal(typeof expected, "object", `${entry.id}: missing expected object`)
    assert.ok(
      primaryIntents.has(String(expected.primary_intent)),
      `${entry.id}: unsupported primary_intent`,
    )
    assert.ok(
      productRequestKinds.has(String(expected.product_request_kind)),
      `${entry.id}: unsupported product_request_kind`,
    )
    assert.ok(
      routineIntents.has(String(expected.routine_intent)),
      `${entry.id}: unsupported routine_intent`,
    )
    assert.ok(
      careCategories.has(String(expected.care_category)),
      `${entry.id}: unsupported care_category`,
    )
    assert.ok(
      countPolicies.has(String(expected.count_policy)),
      `${entry.id}: unsupported count_policy`,
    )
    assert.ok(
      typeof expected.requested_product_count === "number" ||
        expected.requested_product_count === null,
      `${entry.id}: requested_product_count must be number or null`,
    )
    assert.ok(
      toolRequirements.has(String(expected.required_tool)),
      `${entry.id}: unsupported required_tool`,
    )
    assert.equal(typeof expected.must_not_surface_products, "boolean")
    assert.equal(typeof expected.must_not_mutate_routine, "boolean")
    assert.ok(
      expected.safety_mode === null ||
        ["normal", "restricted", "hard_short_circuit"].includes(String(expected.safety_mode)),
      `${entry.id}: unsupported safety_mode`,
    )
    assert.equal(typeof expected.requires_evidence_quote, "boolean")

    const criteria = entry.answer_quality_criteria
    assert.ok(Array.isArray(criteria), `${entry.id}: answer_quality_criteria must be an array`)
    assert.ok(
      criteria.length >= 2,
      `${entry.id}: answer_quality_criteria should be light but meaningful`,
    )
    for (const criterion of criteria) {
      assert.ok(
        answerQualityCriteria.has(String(criterion)),
        `${entry.id}: unsupported quality criterion`,
      )
    }
  }

  const dimensions = new Set(cases.map((entry) => entry.dimension))
  for (const expectedDimension of [
    "concrete_product_ask",
    "category_education",
    "explicit_count",
    "vague_count",
    "capped_count",
    "product_comparison",
    "routine_build",
    "routine_mutation",
    "routine_context_product_ask",
    "routine_summary",
    "routine_exit",
    "multi_turn_reference",
    "safety_hard_short_circuit",
    "safety_restricted",
    "general_advice",
    "smalltalk",
    "unknown",
  ]) {
    assert.ok(
      dimensions.has(expectedDimension),
      `missing regression dimension: ${expectedDimension}`,
    )
  }
})

test("AgentV2 regression fixture represents routine product follow-ups as specific products plus routine context", () => {
  const regressionCases = JSON.parse(
    readFileSync("data/agent-v2/evals/request-interpretation-regression.json", "utf8"),
  ) as Array<{
    id: string
    expected: {
      primary_intent: string
      product_request_kind: string
      required_tool: string
      routine_context_required?: boolean
    }
  }>

  const entry = regressionCases.find(
    (item) => item.id === "request-interpretation-routine-first-addon-deep-dive",
  )
  assert.ok(entry)
  assert.equal(entry.expected.primary_intent, "product_recommendation")
  assert.equal(entry.expected.product_request_kind, "specific_products")
  assert.equal(entry.expected.required_tool, "select_products")
  assert.equal(entry.expected.routine_context_required, true)
})
