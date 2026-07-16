import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  classifyAgentV2ProductionSafetyMode,
  runAgentV2ProductionPipeline,
} from "../src/lib/agent-v2/production/chat-pipeline"
import { createChatPostHandler } from "../src/app/api/chat/route"
import { loadAgentV2ProductionConversationHistory } from "../src/lib/agent-v2/production/conversation-history"
import { deriveIntent, deriveMatchedProducts } from "../src/lib/agent-v2/production/product-output"
import { createDefaultConversationState } from "../src/lib/chat-runtime/conversation-state"
import { buildRecommendationEngineRuntimeForChat } from "../src/lib/recommendation-engine"
import type {
  createSelectProductsTool,
  SelectProductsToolResult,
} from "../src/lib/agent/tools/select-products"
import type {
  AgentV2RoutineThreadContext,
  AgentV2SessionMemoryWrite,
} from "../src/lib/agent-v2/contracts"
import type { TrackingToolContext } from "../src/lib/agent/tools/tracking-context"
import type { TrackingInsightContext } from "../src/lib/agent/tools/tracking-insights"
import type { AgentV2ResponsesTurnResult } from "../src/lib/agent-v2/runtime/responses-agent"
import type { AgentV2SelectProductsProjection } from "../src/lib/agent-v2/tools/select-products-projection"
import type { ConversationState, HairProfile, Message, Product } from "../src/lib/types"
import {
  createDefaultAgentV2ConversationState,
  normalizeAgentV2ConversationState,
  summarizeAgentV2ConversationState,
  type AgentV2ConversationStateV2,
} from "../src/lib/agent-v2/production/persisted-session-state"
type SelectProductsToolParams = Parameters<ReturnType<typeof createSelectProductsTool>>[0]

const verifyConversationOwnership = async ({
  conversationId,
  userId,
}: {
  conversationId: string
  userId: string
}) => {
  assert.equal(typeof conversationId, "string")
  assert.equal(typeof userId, "string")
  return true
}

function createProduct(id: string): Product & { similarity: number } {
  return {
    id,
    name: `Produkt ${id}`,
    brand: "Testmarke",
    description: null,
    short_description: null,
    category: "Shampoo",
    affiliate_link: null,
    image_url: null,
    price_eur: 9.99,
    currency: "EUR",
    tags: [],
    suitable_thicknesses: [],
    suitable_concerns: [],
    shampoo_bucket_pairs: null,
    is_active: true,
    sort_order: 0,
    recommendation_meta: null,
    similarity: 0.9,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
  }
}

function createCompleteHairProfile(overrides: Partial<HairProfile> = {}): HairProfile {
  return {
    id: "profile-1",
    user_id: "user-1",
    hair_texture: "wavy",
    thickness: "fine",
    hair_length: null,
    density: "medium",
    concerns: ["frizz"],
    products_used: null,
    shampoo_frequency: "weekly_3_4x",
    heat_styling: "rarely",
    styling_tools: [],
    goals: ["curl_definition"],
    cuticle_condition: "rough",
    protein_moisture_balance: "stretches_bounces",
    scalp_type: "balanced",
    scalp_condition: null,
    chemical_treatment: ["natural"],
    desired_volume: "balanced",
    routine_preference: "balanced",
    current_routine_products: ["shampoo", "conditioner"],
    towel_material: null,
    towel_technique: null,
    drying_method: "air_dry",
    brush_type: null,
    night_protection: [],
    uses_heat_protection: false,
    additional_notes: null,
    conversation_memory: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  }
}

function createMessage(index: number): Message {
  return {
    id: `message-${index}`,
    conversation_id: "conversation-1",
    role: index % 2 === 0 ? "assistant" : "user",
    content: `Message ${index}`,
    product_recommendations: null,
    message_context: null,
    token_usage: null,
    langfuse_trace_id: null,
    langfuse_trace_url: null,
    user_feedback_score: null,
    user_feedback_at: null,
    created_at: `2026-05-29T10:${String(index).padStart(2, "0")}:00.000Z`,
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
  }

  return output + decoder.decode()
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function createFakeChatAdminClient(params: {
  messageRows: Array<Record<string, unknown>>
  conversationUpdates: Array<Record<string, unknown>>
}) {
  return {
    from(table: string) {
      const query = {
        operation: null as "insert" | "update" | "select" | null,
        payload: null as Record<string, unknown> | null,
        filters: [] as Array<{ column: string; value: unknown }>,
        insert(payload: Record<string, unknown>) {
          this.operation = "insert"
          this.payload = payload
          if (table === "messages") {
            params.messageRows.push(payload)
          }
          return this
        },
        update(payload: Record<string, unknown>) {
          this.operation = "update"
          this.payload = payload
          if (table === "conversations") {
            params.conversationUpdates.push(payload)
          }
          return this
        },
        select() {
          this.operation = this.operation ?? "select"
          return this
        },
        eq(column: string, value: unknown) {
          this.filters.push({ column, value })
          return this
        },
        async single() {
          if (table === "conversations") {
            return { data: { id: "conversation-1" }, error: null }
          }
          if (table === "messages" && this.operation === "insert") {
            return { data: { id: `message-${params.messageRows.length}` }, error: null }
          }
          if (table === "profiles") {
            return { data: { message_count_this_month: 0 }, error: null }
          }
          return { data: null, error: null }
        },
      }

      return query
    },
  }
}

function createAgentV2Result(): AgentV2ResponsesTurnResult {
  return {
    accepted_session_memory_writes: [],
    final_answer: {
      answer_mode: "product_recommendation",
      interpreted_intent: "User wants a shampoo recommendation.",
      request_interpretation: {
        primary_intent: "product_recommendation",
        product_request_kind: "specific_products",
        routine_intent: "none",
        care_category: "shampoo",
        requested_product_count: 1,
        count_policy: "exact",
        evidence_quote: "Welches Shampoo passt?",
        specific_product_candidate: false,
        confidence: 0.95,
      },
      confidence: 0.92,
      extracted_constraints: {
        hair_concerns: ["frizz"],
        goals: [],
        product_categories: ["shampoo"],
        budget_eur: null,
        avoid_ingredients: [],
        allergies: [],
        preferences: [],
        routine_layer: null,
        raw_constraints: ["Welches Shampoo passt?"],
      },
      missing_information: [],
      safety_flags: [],
      tool_grounding: {
        used_guidance_package_ids: ["base.advisor_rules.v1", "category.shampoo.v1"],
        used_product_tool: true,
        used_routine_tool: false,
        product_ids: ["primary"],
        routine_step_ids: [],
        hard_rule_ids: [],
      },
      routine_context: {
        active: false,
        routine_layer: null,
        step_id: null,
        category: "shampoo",
        return_path: [],
      },
      pending_followup_action: null,
      session_memory_writes: [],
      payload: {
        user_facing_answer_de: "Nimm zuerst Produkt primary.",
        recommendations: [
          {
            product_id: "primary",
            reason_de: "Passt zu deinem Profil.",
            usage_de: null,
            caveat_de: null,
          },
        ],
        comparison_notes_de: [],
        usage_notes_de: [],
        next_step_offer_de: null,
      },
    },
    trace: {
      engine: "agent_v2",
      model: "gpt-5.4-mini",
      endpoint: "responses",
      reasoning_effort: "medium",
      safety_mode: "normal",
      answer_mode: "product_recommendation",
      named_product_context: null,
      response_ids: ["response-1"],
      model_steps: [
        {
          response_id: "response-1",
          tool_call_count: 1,
          terminal_answer_count: 0,
          output_types: ["function_call"],
          latency_ms: 7,
        },
      ],
      tool_calls: [
        {
          call_id: "select-1",
          name: "select_products",
          arguments: { category: "shampoo" },
          latency_ms: 1,
        },
      ],
      blocked_tool_calls: [],
      loaded_guidance_package_ids: ["base.advisor_rules.v1", "category.shampoo.v1"],
      validation_errors: [],
      validation_warnings: [],
      request_interpretation: null,
      request_interpretation_summary: null,
      bounded_repair_kind: null,
      repair_attempts: [],
      routine_thread_context_active: false,
      routine_thread_context: null,
      final_product_ids: ["primary"],
      routine_layer: null,
      session_memory_writes: [],
      dropped_session_memory_writes: [],
      injected_session_memory: [],
      langfuse: {
        enabled: true,
        trace_id: null,
        trace_url: null,
      },
      failure_stage: null,
    },
  }
}

test("AgentV2 persisted state defaults to an empty version-2 envelope", () => {
  const state = createDefaultAgentV2ConversationState()

  assert.equal(state.version, 2)
  assert.equal(state.engine, "agent_v2_care_balance")
  assert.equal(state.agent_v2.routine_thread_context, null)
  assert.deepEqual(state.agent_v2.prior_selected_product_projections, [])
  assert.equal(state.agent_v2.active_resolved_product_context, null)
  assert.deepEqual(state.agent_v2.session_memory, [])
})

test("AgentV2 production conversation history loads the latest ten messages chronologically", async () => {
  const returnedMessages = Array.from({ length: 10 }, (_, index) => createMessage(12 - index))
  const calls: Array<{ name: string; args: unknown[] }> = []
  const fakeClient = {
    from(table: string) {
      calls.push({ name: "from", args: [table] })
      return {
        select(columns: string) {
          calls.push({ name: "select", args: [columns] })
          return {
            eq(column: string, value: string) {
              calls.push({ name: "eq", args: [column, value] })
              return {
                order(column: string, options: { ascending: boolean }) {
                  calls.push({ name: "order", args: [column, options] })
                  return {
                    async limit(count: number) {
                      calls.push({ name: "limit", args: [count] })
                      return { data: returnedMessages, error: null }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  const messages = await loadAgentV2ProductionConversationHistory("conversation-1", fakeClient)

  assert.deepEqual(calls.find((call) => call.name === "order")?.args, [
    "created_at",
    { ascending: false },
  ])
  assert.deepEqual(calls.find((call) => call.name === "limit")?.args, [10])
  assert.deepEqual(
    messages.map((message) => message.content),
    [
      "Message 3",
      "Message 4",
      "Message 5",
      "Message 6",
      "Message 7",
      "Message 8",
      "Message 9",
      "Message 10",
      "Message 11",
      "Message 12",
    ],
  )
})

test("AgentV2 production conversation history normalizes legacy-only message context", async () => {
  const legacyMessage = {
    ...createMessage(2),
    content: "Das Produkt wurde geprueft [1].",
    message_context: null,
    rag_context: {
      product_intake_review: {
        submission_id: "submission-1",
        status: "approved",
        approved_product_id: "product-1",
      },
      sources: [{ index: 1 }],
    },
  }
  const fakeClient = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return {
                    async limit() {
                      return { data: [legacyMessage], error: null }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  const [message] = await loadAgentV2ProductionConversationHistory("conversation-1", fakeClient)

  assert.equal(message.content, "Das Produkt wurde geprueft.")
  assert.deepEqual(message.message_context?.product_intake_review, {
    submission_id: "submission-1",
    status: "approved",
    approved_product_id: "product-1",
  })
  assert.equal("rag_context" in message, false)
  assert.equal("sources" in (message.message_context ?? {}), false)
})

test("AgentV2 production conversation history checks ownership before loading admin-scoped messages", async () => {
  const returnedMessages = [createMessage(1)]
  const calls: Array<{ table: string; column: string; value: string }> = []
  const fakeClient = {
    from(table: string) {
      return {
        select() {
          return {
            eq(column: string, value: string) {
              calls.push({ table, column, value })
              if (table === "conversations") {
                return {
                  eq(nextColumn: string, nextValue: string) {
                    calls.push({ table, column: nextColumn, value: nextValue })
                    return {
                      async maybeSingle() {
                        return { data: { id: "conversation-1" }, error: null }
                      },
                    }
                  },
                }
              }

              return {
                order() {
                  return {
                    async limit() {
                      return { data: returnedMessages, error: null }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  const messages = await loadAgentV2ProductionConversationHistory(
    "conversation-1",
    "user-1",
    fakeClient,
  )

  assert.deepEqual(
    calls.filter((call) => call.table === "conversations"),
    [
      { table: "conversations", column: "id", value: "conversation-1" },
      { table: "conversations", column: "user_id", value: "user-1" },
    ],
  )
  assert.deepEqual(messages, returnedMessages)
})

test("AgentV2 production conversation history fails loudly when messages cannot be loaded", async () => {
  const fakeClient = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              if (table === "conversations") {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        return { data: { id: "conversation-1" }, error: null }
                      },
                    }
                  },
                }
              }

              return {
                order() {
                  return {
                    async limit() {
                      return { data: null, error: { message: "database unavailable" } }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  await assert.rejects(
    () => loadAgentV2ProductionConversationHistory("conversation-1", "user-1", fakeClient),
    /Failed to load AgentV2 production conversation history/,
  )
})

test("AgentV2 persisted state ignores legacy behavior fields without flat AgentV2 context", () => {
  const state = normalizeAgentV2ConversationState({
    version: 1,
    active_topic: "routine",
    routine_layer: "basics",
    pending_offer: "routine_goals_or_problems",
    answered_slots: ["routine"],
    last_assistant_action: "asked_routine_basics",
    last_product_category: "leave_in",
  })

  assert.equal(state.version, 2)
  assert.equal(state.engine, "agent_v2_care_balance")
  assert.equal(state.agent_v2.routine_thread_context, null)
  assert.deepEqual(state.agent_v2.prior_selected_product_projections, [])
  assert.equal(state.agent_v2.active_resolved_product_context, null)
  assert.deepEqual(state.agent_v2.session_memory, [])
})

test("AgentV2 persisted state promotes flat AgentV2 fields from current version-1 rows", () => {
  const routineThread: AgentV2RoutineThreadContext = {
    active: true,
    current_layer: "basics",
    last_answer_mode: "routine",
    last_routine_categories: ["leave_in"],
    last_user_goal: "Ich will meine Routine einfacher machen.",
    summary_de: "Leave-in ist der erste Zusatz.",
    pending_followup_action: null,
    visible_steps: [],
  }
  const sessionMemory: AgentV2SessionMemoryWrite = {
    type: "preference",
    text: "User likes light products.",
    evidence_quote: "Ich mag leichte Produkte.",
    confidence: 0.9,
    ttl: "session",
    affects_recommendations: true,
    expires_at_turn: null,
  }

  const state = normalizeAgentV2ConversationState({
    version: 1,
    active_topic: "routine",
    routine_layer: "goals",
    agent_v2_routine_thread_context: routineThread,
    agent_v2_prior_selected_product_projections: [
      {
        tool_name: "select_products",
        category: "leave_in",
        valid_product_ids: ["leave-in-1"],
        products: [
          {
            product_id: "leave-in-1",
            name: "Leave-in Beispiel",
            rank: 1,
          },
        ],
      },
    ],
    agent_v2_session_memory: [sessionMemory],
  })

  assert.equal(state.version, 2)
  assert.deepEqual(state.agent_v2.routine_thread_context, routineThread)
  assert.equal(state.agent_v2.prior_selected_product_projections.length, 1)
  assert.equal(state.agent_v2.session_memory.length, 1)
})

test("AgentV2 persisted state normalizes legacy active product context into max-three array shape", () => {
  const state = normalizeAgentV2ConversationState({
    version: 1,
    agent_v2_active_resolved_product_context: {
      source: "product_lookup_selection",
      product_id: "product-legacy",
      name: "Syoss Intense Volume Shampoo",
      category: "shampoo",
      original_user_message: "passt das Syoss Volume Shampoo zu mir?",
    },
  })

  assert.deepEqual(state.agent_v2.active_product_contexts, [
    {
      status: "resolved",
      product_id: "product-legacy",
      submission_id: null,
      category: "shampoo",
      brand_text: null,
      product_name_text: "Syoss Intense Volume Shampoo",
      display_name: "Syoss Intense Volume Shampoo",
      original_user_message: "passt das Syoss Volume Shampoo zu mir?",
      source: "product_lookup_selection",
      updated_at: "1970-01-01T00:00:00.000Z",
    },
  ])
  assert.equal(state.agent_v2.active_resolved_product_context?.product_id, "product-legacy")
})

test("AgentV2 persisted state keeps routine-inventory active product contexts", () => {
  const state = normalizeAgentV2ConversationState({
    version: 2,
    engine: "agent_v2_care_balance",
    agent_v2: {
      active_product_contexts: [
        {
          status: "resolved",
          product_id: "routine-conditioner",
          submission_id: null,
          category: "conditioner",
          brand_text: "John Frieda",
          product_name_text: "Frizz Ease Wunder-Reparatur Conditioner",
          display_name: "John Frieda Frizz Ease Wunder-Reparatur Conditioner",
          original_user_message: "Ja passt das zu mir?",
          source: "routine_inventory",
          updated_at: "2026-07-03T14:15:00.000Z",
        },
      ],
    },
  })

  assert.equal(state.agent_v2.active_product_contexts.length, 1)
  assert.equal(state.agent_v2.active_product_contexts[0]?.source, "routine_inventory")
  assert.equal(state.agent_v2.active_resolved_product_context?.product_id, "routine-conditioner")
  assert.equal(state.agent_v2.active_resolved_product_context?.source, "routine_inventory")
})

test("AgentV2 production pipeline activates matched routine shampoo identity from current-product question", async () => {
  let receivedActiveResolvedProductContext: unknown = "not-called"

  await runAgentV2ProductionPipeline(
    {
      message: "Weißt du welches Shampoo ich gerade benutze?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-current-shampoo-identity-context",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Syoss Intense Volume Shampoo",
            frequency_range: "weekly_3_4x",
            brand_text: "Syoss",
            product_id: "syoss-intense-volume-shampoo",
            product_submission_id: null,
            match_status: "matched",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveResolvedProductContext = params.activeResolvedProductContext
        return createAgentV2Result()
      },
    },
  )

  assert.deepEqual(receivedActiveResolvedProductContext, {
    source: "routine_inventory",
    product_id: "syoss-intense-volume-shampoo",
    name: "Syoss Intense Volume Shampoo",
    category: "shampoo",
    original_user_message: "Weißt du welches Shampoo ich gerade benutze?",
  })
})

test("AgentV2 production pipeline keeps raw tracker facts separate from explanation-only insights", async () => {
  let receivedTrackingContext: TrackingToolContext | null | undefined
  let receivedTrackingInsightContext: TrackingInsightContext | null | undefined

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Wann habe ich zuletzt meine Haare gewaschen?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-tracker-context",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      loadTrackerDays: async () => ({
        status: "available",
        reason: "loaded",
        referenceDate: "2099-01-01",
        activeDismissals: [],
        days: [
          {
            loggedOn: "2099-01-01",
            dayType: "wash",
            products: [
              { category: "shampoo", productName: "Test Shampoo", userProductUsageId: null },
            ],
          },
        ],
      }),
      client: { responses: { create: async () => ({ output: [] }) } },
      runAgentV2ResponsesTurn: async (params) => {
        receivedTrackingContext = params.userContext.trackingContext
        receivedTrackingInsightContext = params.userContext.trackingInsightContext
        return createAgentV2Result()
      },
    },
  )

  assert.equal(receivedTrackingContext?.mode, "tracking_observation_context")
  assert.equal(receivedTrackingContext?.logged_days[0]?.date, "2099-01-01")
  assert.equal(receivedTrackingInsightContext?.mode, "tracking_insight_context")
  assert.equal(receivedTrackingInsightContext?.coverage.sufficient, false)
  assert.equal(receivedTrackingInsightContext?.authority.may_update_profile, false)
  assert.deepEqual(result.debugTrace.agent_v2_trace?.tracker_context, {
    load_status: "available",
    load_reason: "loaded",
    logged_day_count: 1,
    insight_count: 0,
    load_ms: result.debugTrace.agent_v2_trace?.tracker_context?.load_ms,
  })
})

test("AgentV2 persisted state keeps only three active product contexts and derives primary resolved product", () => {
  const state = normalizeAgentV2ConversationState({
    version: 2,
    engine: "agent_v2_care_balance",
    agent_v2: {
      active_product_contexts: ["one", "two", "three", "four"].map((label, index) => ({
        status: "resolved",
        product_id: `product-${label}`,
        submission_id: null,
        category: index % 2 === 0 ? "shampoo" : "conditioner",
        brand_text: "Brand",
        product_name_text: `Produkt ${label}`,
        display_name: `Produkt ${label}`,
        original_user_message: `Frage zu Produkt ${label}`,
        source: index === 0 ? "lookup_exact" : "product_lookup_selection",
        updated_at: `2026-06-28T10:0${index}:00.000Z`,
      })),
    },
  })

  assert.deepEqual(
    state.agent_v2.active_product_contexts.map((context) => context.product_id),
    ["product-two", "product-three", "product-four"],
  )
  const summary = summarizeAgentV2ConversationState(state)
  assert.equal(summary.active_product_context_count, 3)
  assert.equal(summary.active_resolved_product.product_id, "product-four")
})

test("AgentV2 persisted state normalizes legacy pending routine action into pending follow-up action", () => {
  const state = normalizeAgentV2ConversationState({
    version: 1,
    active_topic: "routine",
    routine_layer: "basics",
    agent_v2_routine_thread_context: {
      active: true,
      current_layer: "basics",
      last_answer_mode: "general_advice",
      last_routine_categories: ["leave_in"],
      last_user_goal: "Ich will meine Routine erweitern.",
      summary_de: "Assistant offered a leave-in step.",
      pending_routine_action: {
        action: "add_step",
        routine_layer: "basics",
        category: "leave_in",
        source: "assistant_offer",
      },
      visible_steps: [],
    },
  })

  assert.deepEqual(state.agent_v2.routine_thread_context?.pending_followup_action, {
    kind: "routine_mutation",
    category: "leave_in",
    routine_layer: "basics",
    routine_action: "add_step",
    source: "assistant_offer",
  })
})

test("AgentV2 persisted state recovers from malformed persisted state", () => {
  const state = normalizeAgentV2ConversationState({
    version: 2,
    engine: "agent_v2_care_balance",
    agent_v2: {
      routine_thread_context: { active: "not-a-boolean" },
      prior_selected_product_projections: "bad",
      session_memory: [{ type: "bad" }],
    },
  })

  assert.equal(state.version, 2)
  assert.deepEqual(state.agent_v2.prior_selected_product_projections, [])
  assert.deepEqual(state.agent_v2.session_memory, [])
  assert.equal(state.agent_v2.routine_thread_context, null)
})

test("AgentV2 production pipeline rejects mismatched user and conversation before loading history or state", async () => {
  let historyLoaded = false
  let stateLoaded = false

  await assert.rejects(
    () =>
      runAgentV2ProductionPipeline(
        {
          message: "Hallo",
          conversationId: "conversation-owned-by-user-2",
          userId: "user-1",
          requestId: "request-ownership",
        },
        {
          verifyConversationOwnership: async ({ conversationId, userId }) => {
            assert.equal(conversationId, "conversation-owned-by-user-2")
            assert.equal(userId, "user-1")
            return false
          },
          loadConversationHistory: async () => {
            historyLoaded = true
            return []
          },
          getUserContext: async () => ({
            profile: createCompleteHairProfile(),
            routine_inventory: [],
            relevant_memory: [],
            derived_signals: [],
            suggested_overlays: [],
            missing_profile: [],
          }),
          loadUserMemoryContext: async () => ({
            enabled: true,
            entries: [],
            promptContext: null,
            dislikedProductNames: [],
          }),
          loadConversationState: async () => {
            stateLoaded = true
            return createDefaultConversationState()
          },
          runAgentV2ResponsesTurn: async () => createAgentV2Result(),
        },
      ),
    /does not belong to user/i,
  )

  assert.equal(historyLoaded, false)
  assert.equal(stateLoaded, false)
})

test("AgentV2 production pipeline returns cards, trace, and CareBalance context", async () => {
  const primaryProduct = createProduct("primary")
  const fallbackProduct = createProduct("fallback")
  const hairProfile = createCompleteHairProfile()
  const selection: SelectProductsToolResult = {
    projection: {
      category: "shampoo",
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: "Explicit product ask.",
      profile_basis: [],
      category_guidance: "Shampoo passt als konkrete Produktempfehlung.",
      products: [fallbackProduct, primaryProduct].map((product, index) => ({
        rank: index + 1,
        product_id: product.id,
        name: product.name,
        brand: product.brand,
        price_eur: product.price_eur,
        currency: product.currency,
        fit_reason: `Passt ${product.id}.`,
        caveat: null,
        supported_claims: [],
        unsupported_requested_signals: [],
      })),
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [fallbackProduct, primaryProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "shampoo",
      message: "Welches Shampoo passt?",
    }),
  }
  let sawCareBalanceContext = false
  let selectedProductsCalled = false

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Welches Shampoo passt?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () =>
        [
          {
            id: "m1",
            conversation_id: "conversation-1",
            role: "user",
            content: "Sensitive recent context",
            product_recommendations: null,
            message_context: null,
            token_usage: null,
            langfuse_trace_id: null,
            langfuse_trace_url: null,
            user_feedback_score: null,
            user_feedback_at: null,
            created_at: "2026-05-12T10:01:00.000Z",
          },
        ] satisfies Message[],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) => {
          selectedProductsCalled = true
          assert.equal(input.category, "shampoo")
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        sawCareBalanceContext = Boolean(params.userContext.careBalanceContext)
        await params.tools.select_products({ category: "shampoo" })
        return createAgentV2Result()
      },
    },
  )

  assert.equal(sawCareBalanceContext, true)
  assert.equal(selectedProductsCalled, true)
  assert.equal(await readStream(result.stream), "Nimm zuerst Produkt primary.")
  assert.equal(result.intent, "product_recommendation")
  assert.deepEqual(
    result.matchedProducts.map((product) => product.id),
    ["primary"],
  )
  assert.equal(result.routerDecision.retrieval_mode, "agent_v2_responses")
  assert.equal(result.routerDecision.response_mode, "answer_direct")
  assert.equal(result.conversationStateTransition.updated_by_engine, "agent_v2_care_balance")
  assert.equal(result.categoryDecision?.category, "shampoo")
  assert.equal(result.engineTrace?.request_context.requestedCategory, "shampoo")
  assert.equal(result.debugTrace.engine_variant, "agent_v2_care_balance")
  assert.equal(result.debugTrace.agent_v2_trace?.engine, "agent_v2")
  assert.equal(result.debugTrace.latencies_ms.product_matching_ms, 0)
  assert.equal(result.debugTrace.latencies_ms.agent_model_ms, 7)
  assert.equal(result.debugTrace.latencies_ms.agent_tool_ms, 1)
  assert.equal(typeof result.debugTrace.latencies_ms.agent_runtime_ms, "number")
  assert.deepEqual(
    result.debugTrace.agent_v2_trace?.tool_calls.map((call) => call.name),
    ["select_products"],
  )
  assert.equal(result.debugTrace.response_composition.attachment_mode, "cards")
  assert.equal(result.debugTrace.user_message, "[agent_v2_user_message chars=22]")
  assert.equal(JSON.stringify(result.debugTrace.prompt).includes("Welches Shampoo passt?"), false)
  assert.equal(JSON.stringify(result.debugTrace.prompt).includes("Sensitive recent context"), false)
  assert.equal(result.debugTrace.agent_v2_trace?.failure_stage, null)
  assert.equal(
    JSON.stringify(result.debugTrace.agent_v2_trace).includes("prior_selected_product_projections"),
    false,
  )
})

test("AgentV2 select-products state stays tied to the overlapping tool call result", async () => {
  const primaryProduct = createProduct("primary")
  const otherProduct = createProduct("other")
  const hairProfile = createCompleteHairProfile()
  const makeSelection = (
    category: "shampoo" | "conditioner",
    product: Product & { similarity: number },
  ): SelectProductsToolResult => ({
    projection: {
      category,
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: `Explicit ${category} ask.`,
      profile_basis: [],
      category_guidance: `${category} guidance.`,
      products: [
        {
          rank: 1,
          product_id: product.id,
          name: product.name,
          brand: product.brand,
          price_eur: product.price_eur,
          currency: product.currency,
          fit_reason: `Passt ${product.id}.`,
          caveat: null,
          supported_claims: [],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [product],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: category,
      message: "Welches Shampoo passt?",
    }),
  })
  const shampooSelection = makeSelection("shampoo", primaryProduct)
  const conditionerSelection = makeSelection("conditioner", otherProduct)
  let resolveConditionerObserved: (() => void) | null = null
  const conditionerObserved = new Promise<void>((resolve) => {
    resolveConditionerObserved = resolve
  })

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Welches Shampoo passt?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      createSelectProductsTool:
        (options = {}) =>
        async (params: SelectProductsToolParams) => {
          if (params.category === "shampoo") {
            options.onResult?.(shampooSelection)
            await conditionerObserved
            return shampooSelection.projection
          }

          options.onResult?.(conditionerSelection)
          resolveConditionerObserved?.()
          return conditionerSelection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        await Promise.all([
          params.tools.select_products({ category: "shampoo" }),
          params.tools.select_products({ category: "conditioner" }),
        ])
        return createAgentV2Result()
      },
    },
  )

  const nextState = result.conversationStateTransition.next_state as AgentV2ConversationStateV2
  assert.equal(
    nextState.agent_v2.prior_selected_product_projections[0]?.products?.[0]?.product_id,
    "primary",
  )
  assert.equal(result.categoryDecision?.category, "shampoo")
  assert.equal(result.engineTrace?.request_context.requestedCategory, "shampoo")
})

test("AgentV2 production pipeline passes lookup-sourced exact product hints into product assessment", async () => {
  const hairProfile = createCompleteHairProfile()
  const lookupProduct = createProduct("lookup-shampoo")
  lookupProduct.name = "Intense Volume Shampoo"
  lookupProduct.brand = "Syoss"

  const selection: SelectProductsToolResult = {
    projection: {
      category: "shampoo",
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: "Exact lookup product assessment.",
      profile_basis: [],
      category_guidance: "Shampoo passt als konkrete Produktbewertung.",
      products: [
        {
          rank: 1,
          product_id: lookupProduct.id,
          name: lookupProduct.name,
          brand: lookupProduct.brand,
          price_eur: lookupProduct.price_eur,
          currency: lookupProduct.currency,
          fit_reason: "Passt als leichtes Shampoo.",
          caveat: null,
          supported_claims: [],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [lookupProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "shampoo",
      message: "Passt Syoss Intense Volume Shampoo zu mir?",
    }),
  }

  await runAgentV2ProductionPipeline(
    {
      message: "Passt Syoss Intense Volume Shampoo zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-lookup-target-hint",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      createProductIntakeRepository: () =>
        ({
          loadCatalog: async () => ({
            products: [
              {
                id: lookupProduct.id,
                name: lookupProduct.name,
                brandId: "brand-syoss",
                categoryKey: "shampoo",
                isActive: true,
                lifecycleStatus: "active",
                isChaarlieRecommended: true,
              },
            ],
            identifiers: [],
          }),
          loadBrandResolutionCatalog: async () => ({
            brands: [{ id: "brand-syoss", canonical_name: "Syoss" }],
            productLines: [],
            brandAliases: [],
          }),
        }) as never,
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) => {
          assert.deepEqual(input.targetProductIds, [lookupProduct.id])
          assert.deepEqual(input.targetProductHints, [
            {
              product_id: lookupProduct.id,
              name: lookupProduct.name,
              category: "shampoo",
            },
          ])
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        const lookupResult = await params.tools.lookup_product_candidate({
          category: "shampoo",
          brand_text: "Syoss",
          product_name_text: "Intense Volume Shampoo",
        })
        assert.equal((lookupResult as { status?: string }).status, "found_exact")

        await params.tools.select_products({
          category: "shampoo",
          product_request_kind: "product_detail",
        })
        return createAgentV2Result()
      },
    },
  )
})

test("AgentV2 production pipeline keeps parallel select_products results isolated", async () => {
  const hairProfile = createCompleteHairProfile()
  const shampooProduct = createProduct("shampoo-product")
  const conditionerProduct = createProduct("conditioner-product")
  const shampooSelection: SelectProductsToolResult = {
    projection: {
      category: "shampoo",
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: "Explicit shampoo comparison.",
      profile_basis: [],
      category_guidance: "Shampoo passt als konkrete Produktempfehlung.",
      products: [
        {
          rank: 1,
          product_id: shampooProduct.id,
          name: shampooProduct.name,
          brand: shampooProduct.brand,
          price_eur: shampooProduct.price_eur,
          currency: shampooProduct.currency,
          fit_reason: "Passt als Shampoo.",
          caveat: null,
          supported_claims: [],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [shampooProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "shampoo",
      message: "Vergleiche Shampoo und Conditioner.",
    }),
  }
  const conditionerSelection: SelectProductsToolResult = {
    projection: {
      category: "conditioner",
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: "Explicit conditioner comparison.",
      profile_basis: [],
      category_guidance: "Conditioner passt als konkrete Produktempfehlung.",
      products: [
        {
          rank: 1,
          product_id: conditionerProduct.id,
          name: conditionerProduct.name,
          brand: conditionerProduct.brand,
          price_eur: conditionerProduct.price_eur,
          currency: conditionerProduct.currency,
          fit_reason: "Passt als Conditioner.",
          caveat: null,
          supported_claims: [],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [conditionerProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "conditioner",
      message: "Vergleiche Shampoo und Conditioner.",
    }),
  }
  const resolvers = new Map<string, (value: SelectProductsToolResult) => void>()

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Vergleiche Shampoo und Conditioner.",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-parallel-select-products",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) =>
          new Promise((resolve) => {
            resolvers.set(input.category, (result) => {
              options.onResult?.(result)
              resolve(result.projection)
            })
          }),
      runAgentV2ResponsesTurn: async (params) => {
        const shampooPromise = params.tools.select_products({ category: "shampoo" })
        const conditionerPromise = params.tools.select_products({ category: "conditioner" })

        resolvers.get("conditioner")?.(conditionerSelection)
        resolvers.get("shampoo")?.(shampooSelection)

        const [shampooProjection, conditionerProjection] = (await Promise.all([
          shampooPromise,
          conditionerPromise,
        ])) as [AgentV2SelectProductsProjection, AgentV2SelectProductsProjection]

        assert.equal(shampooProjection.category, "shampoo")
        assert.equal(conditionerProjection.category, "conditioner")
        return createAgentV2Result()
      },
    },
  )
})

test("AgentV2 production pipeline exposes boundary answer mode without products", async () => {
  const hairProfile = createCompleteHairProfile()
  const boundaryResult = createAgentV2Result()
  boundaryResult.final_answer = {
    ...boundaryResult.final_answer,
    answer_mode: "domain_boundary",
    interpreted_intent: "User asks outside supported hair care.",
    request_interpretation: {
      primary_intent: "unknown",
      product_request_kind: "none",
      routine_intent: "none",
      care_category: "none",
      requested_product_count: null,
      count_policy: "none",
      evidence_quote: "welchen nagellack soll ich kaufen?",
      specific_product_candidate: false,
      confidence: 0.9,
    },
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
    session_memory_writes: [],
    payload: {
      user_facing_answer_de:
        "Bei Nagellack kann ich dir nicht sinnvoll helfen. Ich unterstütze dich gern bei Haarpflege, Kopfhaut, Styling oder passenden Produkten.",
      boundary_kind: "unsupported_domain",
      redirect_topic_de: "Haarpflege, Kopfhaut, Styling oder passende Produkte",
    },
  }
  boundaryResult.trace = {
    ...boundaryResult.trace,
    answer_mode: "domain_boundary",
    tool_calls: [
      {
        call_id: "gate-1",
        name: "classify_turn_gate",
        arguments: { gate_status: "domain_boundary" },
        latency_ms: 1,
      },
    ],
    turn_gate: {
      proposed: {
        gate_status: "domain_boundary",
        evidence_quote: "welchen nagellack soll ich kaufen?",
        confidence: 0.9,
        boundary_kind: "unsupported_domain",
      },
      authorized: {
        gate_status: "domain_boundary",
        evidence_quote: "welchen nagellack soll ich kaufen?",
        confidence: 0.9,
        boundary_kind: "unsupported_domain",
      },
      safety_mode: "normal",
      advisor_continuation_allowed: false,
      enabled: true,
      latency_ms: 8,
    },
    final_product_ids: [],
    session_memory_writes: [],
  }

  const result = await runAgentV2ProductionPipeline(
    {
      message: "welchen nagellack soll ich kaufen?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async () => boundaryResult,
    },
  )

  assert.equal(result.answerMode, "domain_boundary")
  assert.equal(result.intent, "general_chat")
  assert.deepEqual(result.matchedProducts, [])
  assert.equal(result.categoryDecision, undefined)
  assert.equal(result.engineTrace, undefined)
  assert.equal(result.debugTrace.response_composition.attachment_mode, "text_only")
  assert.equal(result.debugTrace.latencies_ms.agent_turn_gate_ms, 8)
  assert.equal(
    await readStream(result.stream),
    boundaryResult.final_answer.payload.user_facing_answer_de,
  )
})

test("/api/chat persists visible boundary turns while skipping AgentV2 state and memory mutation", async () => {
  const messageRows: Array<Record<string, unknown>> = []
  const conversationUpdates: Array<Record<string, unknown>> = []
  const traceRows: Array<Record<string, unknown>> = []
  const statePersistenceCalls: unknown[] = []
  const memoryExtractionCalls: unknown[] = []
  const boundaryAnswer =
    "Bei Nagellack kann ich dir nicht sinnvoll helfen. Ich unterstütze dich gern bei Haarpflege."
  const routerDecision = {
    retrieval_mode: "agent_v2_responses",
    response_mode: "answer_direct",
    slot_completeness: 1,
    confidence: 0.95,
    policy_overrides: [],
  } as const
  const debugTrace = {
    request_id: "request-1",
    started_at: "2026-06-04T12:00:00.000Z",
    user_message: "[agent_v2_user_message chars=32]",
    conversation_id: "conversation-1",
    intent: "general_chat",
    product_category: null,
    conversation_history_count: 0,
    classification: {
      intent: "general_chat",
      product_category: null,
      complexity: "simple",
      needs_clarification: false,
      retrieval_mode: "agent_v2_responses",
      normalized_filters: {},
      router_confidence: 0.95,
    },
    router_decision: routerDecision,
    conversation_state: {
      previous_state: null,
      next_state: null,
      changed_fields: [],
      updated_by_engine: "agent_v2_care_balance",
    },
    clarification_questions: [],
    hair_profile_snapshot: null,
    memory_context: null,
    retrieval: {
      retrieved_count: 0,
      chunks: [],
      citations: [],
    },
    decision_context: {
      should_plan_routine: false,
      routine_plan: null,
      category_decision: null,
      engine_trace: null,
      matched_products: [],
    },
    prompt_refs: {
      classification: null,
      synthesis: null,
    },
    prompt: {
      prompt_id: "agent_v2",
      prompt_ref: null,
      included_sections: [],
      estimated_tokens: 0,
    },
    response_composition: {
      attachment_mode: "text_only",
    },
    engine_variant: "agent_v2_care_balance",
    agent_v2_trace: {
      engine: "agent_v2",
      model: "gpt-5.4-mini",
      endpoint: "responses",
      reasoning_effort: "medium",
      safety_mode: "normal",
      answer_mode: "domain_boundary",
      response_ids: ["response-1"],
      model_steps: [],
      tool_calls: [
        {
          call_id: "gate-1",
          name: "classify_turn_gate",
          arguments: { gate_status: "domain_boundary" },
          latency_ms: 1,
        },
      ],
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
      langfuse: {
        enabled: false,
        trace_id: null,
        trace_url: null,
      },
      failure_stage: null,
      turn_gate: {
        proposed: {
          gate_status: "domain_boundary",
          evidence_quote: "welchen nagellack soll ich kaufen?",
          confidence: 0.9,
          boundary_kind: "unsupported_domain",
        },
        authorized: {
          gate_status: "domain_boundary",
          evidence_quote: "welchen nagellack soll ich kaufen?",
          confidence: 0.9,
          boundary_kind: "unsupported_domain",
        },
        safety_mode: "normal",
        advisor_continuation_allowed: false,
        enabled: true,
        latency_ms: 8,
      },
    },
    latencies_ms: {
      classification_ms: 0,
      hair_profile_load_ms: 0,
      memory_load_ms: 0,
      routine_planning_ms: 0,
      history_load_ms: 0,
      router_ms: 0,
      conversation_create_ms: 0,
      retrieval_ms: 0,
      product_matching_ms: 0,
      prompt_build_ms: 0,
      stream_setup_ms: 0,
      agent_runtime_ms: 10,
      agent_turn_gate_ms: 8,
      agent_model_ms: 9,
      agent_tool_ms: 1,
    },
  }
  const admin = createFakeChatAdminClient({
    messageRows,
    conversationUpdates,
  })
  const handler = createChatPostHandler({
    createClient: async () =>
      ({
        auth: {
          getUser: async () => ({ data: { user: { id: "user-1" } } }),
        },
      }) as never,
    checkRateLimit: async () => ({ allowed: true }) as never,
    ensureLangfuseTracing: () => null,
    flushLangfuseClient: async () => {},
    getLangfuseClient: () =>
      ({
        getTraceUrl: async () => "https://langfuse.test/trace/trace-1",
      }) as never,
    getLangfuseRelease: () => "test-release",
    resolveLangfuseTraceId: () => "trace-1",
    startObservation: () =>
      ({
        otelSpan: {},
        update: () => {},
        end: () => {},
      }) as never,
    propagateAttributes: ((_attributes: unknown, fn: () => unknown) => fn()) as never,
    otelContext: {
      active: () => ({}),
      with: async (_context: unknown, fn: () => unknown) => fn(),
    } as never,
    otelTrace: {
      setSpan: () => ({}),
    } as never,
    loadRuntimeDeps: async () =>
      ({
        createAdminClient: () => admin,
        runAgentV2ProductionPipeline: async () => ({
          stream: createTextStream(boundaryAnswer),
          intent: "general_chat",
          matchedProducts: [],
          routerDecision,
          conversationStateTransition: debugTrace.conversation_state,
          categoryDecision: undefined,
          engineTrace: undefined,
          debugTrace,
          visibleFailure: false,
          answerMode: "domain_boundary",
        }),
        buildAssistantMessageContext: () => null,
        buildDoneEventData: ({ intent }: { intent: string }) => ({ intent }),
        extractConversationMemory: (...args: unknown[]) => {
          memoryExtractionCalls.push(args)
          return Promise.resolve()
        },
        finalizeChatTurnTrace: (
          trace: Record<string, unknown>,
          params: Record<string, unknown>,
        ) => ({
          ...trace,
          status: params.status,
          conversation_state_persistence: params.conversation_state_persistence,
        }),
        summarizeEngineTraceForLangfuse: () => null,
        summarizeProductsForLangfuse: () => [],
        summarizeAgentV2TraceForLangfuse: () => ({ answer_mode: "domain_boundary" }),
        persistConversationStateTransition: async (...args: unknown[]) => {
          statePersistenceCalls.push(args)
          return { status: "persisted", error: null }
        },
        chatMessageSchema: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
        generateConversationTitle: async () => {},
      }) as never,
    persistConversationTurnTrace: async (row) => {
      traceRows.push(row)
    },
    randomUUID: () => "request-1",
    now: () => 0,
  })

  const response = await handler(
    new Request("https://example.test/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "welchen nagellack soll ich kaufen?",
        conversation_id: "conversation-1",
      }),
    }),
  )
  const responseText = await response.text()

  assert.equal(response.status, 200)
  assert.match(responseText, /conversation_id/)
  assert.match(responseText, new RegExp(boundaryAnswer))
  assert.deepEqual(
    messageRows.map((row) => row.role),
    ["user", "assistant"],
  )
  assert.equal(messageRows[0]?.content, "welchen nagellack soll ich kaufen?")
  assert.equal(messageRows[1]?.content, boundaryAnswer)
  assert.equal(conversationUpdates.length, 1)
  assert.equal(statePersistenceCalls.length, 0)
  assert.equal(memoryExtractionCalls.length, 0)
  assert.equal(traceRows.length, 1)
  const persistedTrace = traceRows[0]?.trace as
    | { conversation_state_persistence?: { status?: string; error?: string | null } }
    | undefined
  assert.deepEqual(persistedTrace?.conversation_state_persistence, {
    status: "skipped",
    error: "answer_mode_no_state_mutation",
  })
})

test("AgentV2 production pipeline uses observed OpenAI and managed prompt refs by default", async () => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY
  const previousObservationFlag = process.env.AGENT_V2_LANGFUSE_OBSERVATION
  process.env.OPENAI_API_KEY = "test-openai-key"
  delete process.env.AGENT_V2_LANGFUSE_OBSERVATION

  const managedRef = {
    name: "chaarlie-agent-v2-responses-care-balance",
    version: 17,
    label: "production",
    is_fallback: false,
  }
  const observedClient = { responses: { create: async () => ({ output: [] }) } }
  let observedConfig: { generationName?: unknown; langfusePrompt?: unknown } | null = null
  let receivedClient: unknown = null

  try {
    const result = await runAgentV2ProductionPipeline(
      {
        message: "Welches Shampoo passt?",
        conversationId: "conversation-1",
        userId: "user-1",
        requestId: "request-1",
      },
      {
        verifyConversationOwnership,
        loadConversationHistory: async () => [],
        getUserContext: async () => ({
          profile: createCompleteHairProfile(),
          routine_inventory: [],
          relevant_memory: [],
          derived_signals: [],
          suggested_overlays: [],
          missing_profile: [],
        }),
        loadUserMemoryContext: async () => ({
          enabled: true,
          entries: [],
          promptContext: null,
          dislikedProductNames: [],
        }),
        loadConversationState: async (): Promise<ConversationState> =>
          createDefaultConversationState(),
        getManagedTextPromptTemplate: async () => ({
          template: "Managed AgentV2 prompt",
          ref: managedRef,
        }),
        getObservedOpenAI: (config) => {
          observedConfig = config ?? {}
          return observedClient as never
        },
        runAgentV2ResponsesTurn: async (params) => {
          receivedClient = params.client
          return createAgentV2Result()
        },
      },
    )

    assert.equal(receivedClient, observedClient)
    assert.notEqual(observedConfig, null)
    const capturedObservedConfig = observedConfig as unknown as {
      generationName?: unknown
      langfusePrompt?: unknown
    }
    assert.equal(capturedObservedConfig.generationName, "agent-v2-responses-step")
    assert.deepEqual(capturedObservedConfig.langfusePrompt, {
      name: managedRef.name,
      version: managedRef.version,
      isFallback: managedRef.is_fallback,
    })
    assert.deepEqual(result.debugTrace.prompt.prompt_ref, managedRef)
    assert.deepEqual(result.debugTrace.prompt_refs.classification, managedRef)
  } finally {
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey
    }
    if (previousObservationFlag === undefined) {
      delete process.env.AGENT_V2_LANGFUSE_OBSERVATION
    } else {
      process.env.AGENT_V2_LANGFUSE_OBSERVATION = previousObservationFlag
    }
  }
})

test("AgentV2 production pipeline can disable observed OpenAI via rollback flag", async () => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY
  const previousObservationFlag = process.env.AGENT_V2_LANGFUSE_OBSERVATION
  process.env.OPENAI_API_KEY = "test-openai-key"
  process.env.AGENT_V2_LANGFUSE_OBSERVATION = "disabled"

  const rawClient = { responses: { create: async () => ({ output: [] }) } }
  const observedClient = { responses: { create: async () => ({ output: [] }) } }
  let observedCalled = false
  let receivedClient: unknown = null

  try {
    await runAgentV2ProductionPipeline(
      {
        message: "Welches Shampoo passt?",
        conversationId: "conversation-1",
        userId: "user-1",
        requestId: "request-1",
      },
      {
        verifyConversationOwnership,
        loadConversationHistory: async () => [],
        getUserContext: async () => ({
          profile: createCompleteHairProfile(),
          routine_inventory: [],
          relevant_memory: [],
          derived_signals: [],
          suggested_overlays: [],
          missing_profile: [],
        }),
        loadUserMemoryContext: async () => ({
          enabled: true,
          entries: [],
          promptContext: null,
          dislikedProductNames: [],
        }),
        loadConversationState: async (): Promise<ConversationState> =>
          createDefaultConversationState(),
        getManagedTextPromptTemplate: async () => ({
          template: "Fallback AgentV2 prompt",
          ref: {
            name: "chaarlie-agent-v2-responses-care-balance",
            version: null,
            label: "staging",
            is_fallback: true,
          },
        }),
        getOpenAI: () => rawClient as never,
        getObservedOpenAI: () => {
          observedCalled = true
          return observedClient as never
        },
        runAgentV2ResponsesTurn: async (params) => {
          receivedClient = params.client
          return createAgentV2Result()
        },
      },
    )

    assert.equal(observedCalled, false)
    assert.equal(receivedClient, rawClient)
  } finally {
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey
    }
    if (previousObservationFlag === undefined) {
      delete process.env.AGENT_V2_LANGFUSE_OBSERVATION
    } else {
      process.env.AGENT_V2_LANGFUSE_OBSERVATION = previousObservationFlag
    }
  }
})

test("AgentV2 production pipeline treats any runtime failure stage as visible failure", async () => {
  const hairProfile = createCompleteHairProfile()
  const product = createProduct("primary")
  const selection: SelectProductsToolResult = {
    projection: {
      category: "shampoo",
      decision: "recommended",
      product_response_policy: "recommend",
      policy_reason: "Explicit product ask.",
      profile_basis: [],
      category_guidance: "Shampoo passt als konkrete Produktempfehlung.",
      products: [
        {
          rank: 1,
          product_id: product.id,
          name: product.name,
          brand: product.brand,
          price_eur: product.price_eur,
          currency: product.currency,
          fit_reason: "Passt.",
          caveat: null,
          supported_claims: [],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [product],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "shampoo",
      message: "Welches Shampoo passt?",
    }),
  }
  const failedResult = createAgentV2Result()
  failedResult.trace.failure_stage = "repair_failed"
  failedResult.trace.validation_errors = []

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Welches Shampoo passt?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      createSelectProductsTool:
        (options = {}) =>
        async () => {
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        await params.tools.select_products({ category: "shampoo" })
        return failedResult
      },
    },
  )

  assert.equal(result.visibleFailure, true)
  assert.equal(result.routerDecision.response_mode, "clarify_only")
  assert.deepEqual(result.matchedProducts, [])
  assert.equal(result.categoryDecision, undefined)
  assert.equal(result.engineTrace, undefined)
  const nextState = result.conversationStateTransition.next_state as AgentV2ConversationStateV2
  assert.deepEqual(nextState.agent_v2.prior_selected_product_projections, [])
  assert.equal(result.debugTrace.agent_v2_trace?.failure_stage, "repair_failed")
})

test("AgentV2 product cards do not fall back to unrelated current-turn products for prior-only ids", () => {
  const currentProduct = createProduct("current-product")
  const hairProfile = createCompleteHairProfile()
  const answer = createAgentV2Result().final_answer
  if (answer.answer_mode !== "product_recommendation") {
    throw new Error("Expected product recommendation fixture")
  }
  answer.tool_grounding.product_ids = ["prior-product"]
  answer.payload.recommendations = [
    {
      product_id: "prior-product",
      reason_de: "War im vorherigen Turn sichtbar.",
      usage_de: null,
      caveat_de: null,
    },
  ]

  assert.deepEqual(
    deriveMatchedProducts({
      answer,
      selectedProductResults: [
        {
          projection: {
            category: "leave_in",
            decision: "recommended",
            product_response_policy: "recommend",
            policy_reason: "Current turn selection.",
            profile_basis: [],
            category_guidance: "",
            products: [
              {
                rank: 1,
                product_id: currentProduct.id,
                name: currentProduct.name,
                brand: currentProduct.brand,
                price_eur: currentProduct.price_eur,
                currency: currentProduct.currency,
                fit_reason: "Current turn product.",
                caveat: null,
                supported_claims: [],
                unsupported_requested_signals: [],
              },
            ],
            comparison_facts: null,
            missing_info: [],
            unsupported_requested_signals: [],
          },
          products: [currentProduct],
          effectiveHairProfile: hairProfile,
          runtime: buildRecommendationEngineRuntimeForChat({
            hairProfile,
            routineItems: [],
            productCategory: "leave_in",
            message: "Warum dieses Produkt?",
          }),
        },
      ],
    }),
    [],
  )
})

test("AgentV2 product assessment does not render product cards from grounding ids", () => {
  const currentProduct = createProduct("current-product")
  const hairProfile = createCompleteHairProfile()
  const base = createAgentV2Result().final_answer
  const answer = {
    ...base,
    answer_mode: "product_assessment",
    tool_grounding: {
      ...base.tool_grounding,
      product_ids: [currentProduct.id],
    },
    payload: {
      assessment_kind: "fit",
      assessed_product_ids: [currentProduct.id],
      user_facing_answer_de: "Dieses Produkt kann ich textlich einordnen.",
    },
  } as typeof base

  assert.deepEqual(
    deriveMatchedProducts({
      answer,
      selectedProductResults: [
        {
          projection: {
            category: "shampoo",
            decision: "recommended",
            product_response_policy: "recommend",
            policy_reason: "Internal assessment grounding.",
            profile_basis: [],
            category_guidance: "",
            products: [
              {
                rank: 1,
                product_id: currentProduct.id,
                name: currentProduct.name,
                brand: currentProduct.brand,
                price_eur: currentProduct.price_eur,
                currency: currentProduct.currency,
                fit_reason: "Internal product facts.",
                caveat: null,
                supported_claims: [],
                unsupported_requested_signals: [],
              },
            ],
            comparison_facts: null,
            missing_info: [],
            unsupported_requested_signals: [],
          },
          products: [currentProduct],
          effectiveHairProfile: hairProfile,
          runtime: buildRecommendationEngineRuntimeForChat({
            hairProfile,
            routineItems: [],
            productCategory: "shampoo",
            message: "Passt dieses Produkt?",
          }),
        },
      ],
    }),
    [],
  )
  assert.equal(deriveIntent(answer), "hair_care_advice")
})

test("AgentV2 production safety mode hard-stops severe persistent shedding", () => {
  assert.equal(
    classifyAgentV2ProductionSafetyMode(
      "Ich verliere extrem viele Haare seit Wochen und es wird nicht besser",
    ),
    "hard_short_circuit",
  )
})

test("AgentV2 production safety mode does not treat hair-loss product names as symptoms", () => {
  assert.equal(
    classifyAgentV2ProductionSafetyMode("Passt das Plantur 39 Anti-Haarverlust Shampoo zu mir?"),
    "normal",
  )
  assert.equal(
    classifyAgentV2ProductionSafetyMode(
      "Was hältst du von dem Anti-Haarausfall Shampoo bei kreisrundem Haarausfall?",
    ),
    "restricted",
  )
  assert.equal(
    classifyAgentV2ProductionSafetyMode(
      "Ist dieses Anti-Haarausfall Serum nach der Schwangerschaft okay?",
    ),
    "restricted",
  )
  assert.equal(
    classifyAgentV2ProductionSafetyMode("Ich habe Haarausfall, passt das Shampoo trotzdem?"),
    "restricted",
  )
})

test("AgentV2 production pipeline carries persisted routine thread context into the runtime", async () => {
  const pendingRoutineContext: AgentV2RoutineThreadContext = {
    active: true,
    current_layer: "basics",
    last_answer_mode: "routine",
    last_routine_categories: ["leave_in"],
    last_user_goal: "Ich will meine Routine erweitern.",
    summary_de: "Leave-in ist der sichtbare naechste Schritt.",
    pending_followup_action: {
      kind: "routine_mutation",
      category: "leave_in",
      routine_layer: "basics",
      routine_action: "add_step",
      source: "assistant_offer",
    },
    visible_steps: [
      {
        step_id: "maintenance-leave-in",
        label_de: "Leave-in",
        category: "leave_in",
        action: "add",
        necessity: "recommended",
        already_in_current_routine: false,
        order: 1,
        routine_layer: "basics",
      },
    ],
  }
  let receivedRoutineContext: unknown
  let receivedRoutineLayer: unknown

  const result = await runAgentV2ProductionPipeline(
    {
      message: "ja bitte",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          active_topic: "routine",
          routine_layer: "goals",
          agent_v2_routine_thread_context: pendingRoutineContext,
        }) as ConversationState,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedRoutineContext = params.routineThreadContext
        receivedRoutineLayer = params.currentRoutineLayer
        return createAgentV2Result()
      },
    },
  )

  const routineContext = receivedRoutineContext as AgentV2RoutineThreadContext | null
  assert.equal(routineContext?.pending_followup_action?.category, "leave_in")
  assert.equal(routineContext?.visible_steps[0]?.step_id, "maintenance-leave-in")
  assert.equal(receivedRoutineLayer, "basics")
  const nextState = result.conversationStateTransition.next_state as AgentV2ConversationStateV2
  assert.equal(nextState.agent_v2.routine_thread_context?.active, false)
})

test("AgentV2 production pipeline carries persisted surfaced product facts into the runtime", async () => {
  const priorProjection: Partial<AgentV2SelectProductsProjection> = {
    tool_name: "select_products",
    category: "leave_in",
    valid_product_ids: ["leave-in-1"],
    products: [
      {
        product_id: "leave-in-1",
        rank: 1,
        name: "Grounded Leave-in",
        brand: "Testmarke",
        price_eur: 12,
        currency: "EUR",
        fit_reason: "War im letzten Turn sichtbar.",
        caveat: null,
        supported_claims: [],
        unsupported_requested_signals: [],
      },
    ],
  }
  let receivedPriorProjectionCount = 0

  await runAgentV2ProductionPipeline(
    {
      message: "Warum genau dieses Produkt?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_prior_selected_product_projections: [priorProjection],
        }) as ConversationState,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedPriorProjectionCount = params.priorSelectedProductProjections?.length ?? 0
        return createAgentV2Result()
      },
    },
  )

  assert.equal(receivedPriorProjectionCount, 1)
})

test("AgentV2 production pipeline passes pending routine inventory submissions into the runtime", async () => {
  let receivedActiveProductContexts: unknown
  let receivedActiveResolvedProductContext: unknown = "not-called"

  await runAgentV2ProductionPipeline(
    {
      message: "Passt es zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-pending-routine-inventory-product",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Repair Shampoo",
            frequency_range: "weekly_1_2x",
            brand_text: "Testmarke",
            product_id: null,
            product_submission_id: "submission-pending-review",
            match_status: "pending_review",
          },
          {
            category: "conditioner",
            product_name: "Soft Conditioner",
            frequency_range: "weekly_1_2x",
            brand_text: "Andere Marke",
            product_id: null,
            product_submission_id: "submission-needs-more-info",
            match_status: "needs_more_info",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      createProductIntakeRepository: () =>
        ({
          findProductSubmission: async (submissionId: string) => {
            if (submissionId === "submission-pending-review") {
              return {
                id: submissionId,
                brand_text: "Testmarke",
                product_name_text: "Repair Shampoo",
                category: "shampoo",
                status: "pending_review",
                updated_at: "1970-01-01T00:00:00.000Z",
              }
            }
            if (submissionId === "submission-needs-more-info") {
              return {
                id: submissionId,
                brand_text: "Andere Marke",
                product_name_text: "Soft Conditioner",
                category: "conditioner",
                status: "needs_more_info",
                updated_at: "1970-01-01T00:00:00.000Z",
              }
            }
            return null
          },
        }) as never,
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveProductContexts = params.activeProductContexts
        receivedActiveResolvedProductContext = params.activeResolvedProductContext
        return createAgentV2Result()
      },
    },
  )

  assert.deepEqual(receivedActiveProductContexts, [
    {
      status: "pending_review",
      product_id: null,
      submission_id: "submission-pending-review",
      category: "shampoo",
      brand_text: "Testmarke",
      product_name_text: "Repair Shampoo",
      display_name: "Testmarke Repair Shampoo",
      original_user_message: "Passt es zu mir?",
      source: "product_intake_submission",
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    {
      status: "pending_review",
      product_id: null,
      submission_id: "submission-needs-more-info",
      category: "conditioner",
      brand_text: "Andere Marke",
      product_name_text: "Soft Conditioner",
      display_name: "Andere Marke Soft Conditioner",
      original_user_message: "Passt es zu mir?",
      source: "product_intake_submission",
      updated_at: "1970-01-01T00:00:00.000Z",
    },
  ])
  assert.equal(receivedActiveResolvedProductContext, null)
})

test("AgentV2 production pipeline resolves pending intake context from approved review notification", async () => {
  let receivedActiveProductContexts: unknown = "not-called"
  let receivedActiveResolvedProductContext: unknown = "not-called"

  const messageDefaults = {
    conversation_id: "conversation-1",
    product_recommendations: null,
    token_usage: null,
    langfuse_trace_id: null,
    langfuse_trace_url: null,
    user_feedback_score: null,
    user_feedback_at: null,
  }

  await runAgentV2ProductionPipeline(
    {
      message: "passt der zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-approved-intake-recovery",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () =>
        [
          {
            ...messageDefaults,
            id: "m1",
            role: "user",
            content: "ich nutze den NEQI Conditioner Diamond Glass, passt der zu mir?",
            message_context: null,
            created_at: "2026-07-05T19:27:13.000Z",
          },
          {
            ...messageDefaults,
            id: "m2",
            role: "assistant",
            content:
              "Ich habe **NEQI Diamond Glass Conditioner** noch nicht in unserer Datenbank. Gib es bitte unten kurz ein.",
            message_context: null,
            created_at: "2026-07-05T19:27:14.000Z",
          },
          {
            ...messageDefaults,
            id: "m3",
            role: "assistant",
            content:
              "Gute Nachrichten: Wir haben **NEQI Diamond Glass Conditioner** geprüft und in deiner Routine verknüpft.",
            message_context: {
              product_intake_review: {
                submission_id: "sub-1",
                status: "approved",
                approved_product_id: "product-neqi-dgc",
              },
            },
            created_at: "2026-07-05T19:53:12.000Z",
          },
        ] satisfies Message[],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          version: 2,
          engine: "agent_v2_care_balance",
          agent_v2: {
            active_product_contexts: [
              {
                status: "pending_review",
                product_id: null,
                submission_id: "sub-1",
                category: "conditioner",
                brand_text: "NEQI",
                product_name_text: "Diamond Glass Conditioner",
                display_name: "NEQI Diamond Glass Conditioner",
                original_user_message: "Ich habe NEQI Diamond Glass Conditioner eingereicht.",
                source: "product_intake_submission",
                updated_at: "2026-07-05T19:30:00.000Z",
              },
            ],
          },
        }) as unknown as ConversationState,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveProductContexts = params.activeProductContexts
        receivedActiveResolvedProductContext = params.activeResolvedProductContext
        return createAgentV2Result()
      },
    },
  )

  assert.ok(Array.isArray(receivedActiveProductContexts))
  const contexts = receivedActiveProductContexts as Array<Record<string, unknown>>
  const recovered = contexts.find((context) => context.submission_id === "sub-1")
  assert.ok(recovered, "expected the intake context for sub-1 to be present")
  assert.equal(recovered.status, "resolved")
  assert.equal(recovered.product_id, "product-neqi-dgc")
  assert.equal(recovered.display_name, "NEQI Diamond Glass Conditioner")
  assert.ok(
    !contexts.some((context) => context.status === "pending_review"),
    "expected no stale pending_review context after approval recovery",
  )
  assert.equal(
    (receivedActiveResolvedProductContext as Record<string, unknown> | null)?.product_id,
    "product-neqi-dgc",
  )
})

test("AgentV2 production pipeline does not keep terminal submissions as pending routine context", async () => {
  let receivedActiveProductContexts: unknown = "not-called"

  await runAgentV2ProductionPipeline(
    {
      message: "Passt es zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-terminal-routine-inventory-product",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Repair Shampoo",
            frequency_range: "weekly_1_2x",
            brand_text: "Testmarke",
            product_id: null,
            product_submission_id: "submission-approved",
            match_status: "pending_review",
          },
          {
            category: "conditioner",
            product_name: "Soft Conditioner",
            frequency_range: "weekly_1_2x",
            brand_text: "Andere Marke",
            product_id: null,
            product_submission_id: "submission-rejected",
            match_status: "needs_more_info",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      createProductIntakeRepository: () =>
        ({
          findProductSubmission: async (submissionId: string) => {
            if (submissionId === "submission-approved") {
              return {
                id: submissionId,
                brand_text: "Testmarke",
                product_name_text: "Repair Shampoo",
                category: "shampoo",
                status: "approved",
                updated_at: "1970-01-01T00:00:00.000Z",
              }
            }
            if (submissionId === "submission-rejected") {
              return {
                id: submissionId,
                brand_text: "Andere Marke",
                product_name_text: "Soft Conditioner",
                category: "conditioner",
                status: "rejected",
                updated_at: "1970-01-01T00:00:00.000Z",
              }
            }
            return null
          },
        }) as never,
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveProductContexts = params.activeProductContexts
        return createAgentV2Result()
      },
    },
  )

  assert.deepEqual(receivedActiveProductContexts, [])
})

test("AgentV2 production pipeline targets approved routine product facts on fit follow-up", async () => {
  const hairProfile = createCompleteHairProfile()
  const approvedProduct = createProduct("primary")
  approvedProduct.name = "L'Oréal Paris Elvital Glycolic Gloss Shampoo"
  const selection: SelectProductsToolResult = {
    projection: {
      category: "shampoo",
      decision: "recommended",
      product_response_policy: "recommend_with_caveat",
      policy_reason: "Approved user-owned product target.",
      profile_basis: [],
      category_guidance: "Shampoo wird als konkretes Zielprodukt bewertet.",
      products: [
        {
          rank: 1,
          product_id: approvedProduct.id,
          name: approvedProduct.name,
          brand: approvedProduct.brand,
          price_eur: approvedProduct.price_eur,
          currency: approvedProduct.currency,
          fit_reason: "Produktdaten wurden geladen.",
          caveat: null,
          supported_claims: [
            {
              field: "shampoo_bucket",
              value: "normal",
              evidence: "product_spec",
              label: "normale Reinigung",
            },
          ],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [approvedProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "shampoo",
      message: "Okay und passt er zu mir?",
    }),
  }
  let receivedActiveResolvedProductContext: unknown = null
  let selectedProductsCalled = false

  await runAgentV2ProductionPipeline(
    {
      message: "Okay und passt er zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-approved-product-fit",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () =>
        [
          {
            ...createMessage(0),
            role: "assistant",
            content:
              "Gute Nachrichten: Wir haben **L'Oréal Paris Elvital Glycolic Gloss Shampoo** geprüft und in deiner Routine verknüpft.\n\nDu kannst mich jetzt konkret dazu fragen, und ich berücksichtige es bei passenden Empfehlungen.",
          },
        ] satisfies Message[],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Glycolic Gloss Shampoo",
            frequency_range: "weekly_3_4x",
            brand_text: "L'Oréal Paris Elvital",
            product_id: approvedProduct.id,
            product_submission_id: "submission-1",
            match_status: "matched",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_active_product_contexts: [
            {
              status: "pending_review",
              product_id: null,
              submission_id: "submission-1",
              category: "shampoo",
              brand_text: "L'Oréal Paris Elvital",
              product_name_text: "Glycolic Gloss Shampoo",
              display_name: "L'Oréal Paris Elvital Glycolic Gloss Shampoo",
              original_user_message:
                "passt das L'Oréal Paris Elvital Shampoo Glycolic Gloss zu mir?",
              source: "product_intake_submission",
              updated_at: "2026-07-03T13:25:00.000Z",
            },
          ],
        }) as ConversationState,
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) => {
          selectedProductsCalled = true
          assert.equal(input.category, "shampoo")
          assert.deepEqual(input.targetProductIds, [approvedProduct.id])
          assert.deepEqual(input.targetProductHints, [
            {
              product_id: approvedProduct.id,
              name: "L'Oréal Paris Elvital Glycolic Gloss Shampoo",
              category: "shampoo",
            },
          ])
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveResolvedProductContext = params.activeResolvedProductContext
        await params.tools.select_products({
          category: "shampoo",
          product_request_kind: "product_detail",
        })
        return createAgentV2Result()
      },
    },
  )

  assert.equal(selectedProductsCalled, true)
  assert.deepEqual(receivedActiveResolvedProductContext, {
    source: "routine_inventory",
    product_id: approvedProduct.id,
    name: "L'Oréal Paris Elvital Glycolic Gloss Shampoo",
    category: "shampoo",
    original_user_message: "Okay und passt er zu mir?",
  })
})

test("AgentV2 production pipeline keeps approved product target when stale prior category leaks into tool call", async () => {
  const hairProfile = createCompleteHairProfile()
  const approvedProduct = createProduct("primary")
  approvedProduct.id = "approved-conditioner"
  approvedProduct.name = "PANTENE PRO-V Moisture Boost Conditioner"
  approvedProduct.brand = "PANTENE PRO-V"
  approvedProduct.category = "Conditioner"

  const selection: SelectProductsToolResult = {
    projection: {
      category: "conditioner",
      decision: "recommended",
      product_response_policy: "recommend_with_caveat",
      policy_reason: "Approved user-owned product target.",
      profile_basis: [],
      category_guidance: "Conditioner wird als konkretes Zielprodukt bewertet.",
      products: [
        {
          rank: 1,
          product_id: approvedProduct.id,
          name: approvedProduct.name,
          brand: approvedProduct.brand,
          price_eur: approvedProduct.price_eur,
          currency: approvedProduct.currency,
          fit_reason: "Produktdaten wurden geladen.",
          caveat: null,
          supported_claims: [
            {
              field: "weight",
              value: "light",
              evidence: "product_spec",
              label: "leichte Pflege",
            },
          ],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [approvedProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "conditioner",
      message: "ja passt er zu mir?",
    }),
  }
  let selectedProductsCalled = false

  await runAgentV2ProductionPipeline(
    {
      message: "ja passt er zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-approved-product-fit-stale-category",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () =>
        [
          {
            ...createMessage(0),
            role: "assistant",
            content:
              "Ich kann den exakten PANTENE PRO-V Moisture Boost Conditioner so noch nicht sicher zuordnen - in der Datenbank taucht dazu nur die Leave-in-Variante auf.",
          },
          {
            ...createMessage(1),
            role: "assistant",
            content:
              "Gute Nachrichten: Wir haben **PANTENE PRO-V Moisture Boost Conditioner** geprüft und in deiner Routine verknüpft.\n\nDu kannst mich jetzt konkret dazu fragen, und ich berücksichtige es bei passenden Empfehlungen.",
          },
        ] satisfies Message[],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [
          {
            category: "conditioner",
            product_name: "Moisture Boost Conditioner",
            frequency_range: "weekly_3_4x",
            brand_text: "PANTENE PRO-V",
            product_id: approvedProduct.id,
            product_submission_id: "submission-conditioner",
            match_status: "matched",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_active_product_contexts: [
            {
              status: "resolved",
              product_id: approvedProduct.id,
              submission_id: "submission-conditioner",
              category: "conditioner",
              brand_text: "PANTENE PRO-V",
              product_name_text: "Moisture Boost Conditioner",
              display_name: "PANTENE PRO-V Moisture Boost Conditioner",
              original_user_message: "passt der PANTENE PRO-V Conditioner Moisture Boost zu mir?",
              source: "product_intake_review",
              updated_at: "2026-07-05T17:54:00.000Z",
            },
          ],
        }) as ConversationState,
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) => {
          selectedProductsCalled = true
          assert.equal(input.category, "conditioner")
          assert.deepEqual(input.targetProductIds, [approvedProduct.id])
          assert.deepEqual(input.targetProductHints, [
            {
              product_id: approvedProduct.id,
              name: "PANTENE PRO-V Moisture Boost Conditioner",
              category: "conditioner",
            },
          ])
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        await params.tools.select_products({
          category: "leave_in",
          product_request_kind: "product_detail",
          reason: "The user asks if the active product fits.",
          user_request: "ja passt er zu mir?",
          constraints: [],
          requested_product_count: 1,
          count_policy: "exact",
          evidence_quote: "ja passt er zu mir?",
        })
        return createAgentV2Result()
      },
    },
  )

  assert.equal(selectedProductsCalled, true)
})

test("AgentV2 production pipeline does not target-only filter alternatives from active product", async () => {
  const hairProfile = createCompleteHairProfile()
  const activeProduct = createProduct("active-conditioner")
  activeProduct.name = "Schwarzkopf GLISS Liquid Silk Spülung"
  activeProduct.brand = "Schwarzkopf GLISS"
  activeProduct.category = "Conditioner"
  const alternativeProduct = createProduct("alternative-conditioner")
  alternativeProduct.name = "Guhl Panthenol + Reparatur 2in1 Kur & Spülung"
  alternativeProduct.brand = "Guhl"
  alternativeProduct.category = "Conditioner"

  const selection: SelectProductsToolResult = {
    projection: {
      category: "conditioner",
      decision: "recommended",
      product_response_policy: "recommend_with_caveat",
      policy_reason: "Alternativen zum aktuellen Conditioner.",
      profile_basis: [],
      category_guidance: "Conditioner-Alternativen werden verglichen.",
      products: [
        {
          rank: 1,
          product_id: alternativeProduct.id,
          name: alternativeProduct.name,
          brand: alternativeProduct.brand,
          price_eur: alternativeProduct.price_eur,
          currency: alternativeProduct.currency,
          fit_reason: "Alternative mit passender Pflegewirkung.",
          caveat: null,
          supported_claims: [
            {
              field: "weight",
              value: "medium",
              evidence: "product_spec",
              label: "mittlere Pflege",
            },
          ],
          unsupported_requested_signals: [],
        },
      ],
      comparison_facts: null,
      missing_info: [],
      unsupported_requested_signals: [],
    },
    products: [alternativeProduct],
    effectiveHairProfile: hairProfile,
    runtime: buildRecommendationEngineRuntimeForChat({
      hairProfile,
      routineItems: [],
      productCategory: "conditioner",
      message: "okay, was wären sonst Alternativen?",
    }),
  }
  let selectedProductsCalled = false

  await runAgentV2ProductionPipeline(
    {
      message: "okay, was wären sonst Alternativen?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-active-product-alternatives-no-target-filter",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () =>
        [
          {
            ...createMessage(0),
            role: "assistant",
            content: "**Schwarzkopf GLISS Liquid Silk Spülung** passt zu dir tendenziell gut.",
          },
        ] satisfies Message[],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [
          {
            category: "conditioner",
            product_name: "Liquid Silk Spülung",
            frequency_range: "weekly_3_4x",
            brand_text: "Schwarzkopf GLISS",
            product_id: activeProduct.id,
            product_submission_id: "submission-gliss",
            match_status: "matched",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_active_product_contexts: [
            {
              status: "resolved",
              product_id: activeProduct.id,
              submission_id: "submission-gliss",
              category: "conditioner",
              brand_text: "Schwarzkopf GLISS",
              product_name_text: "Liquid Silk Spülung",
              display_name: "Schwarzkopf GLISS Liquid Silk Spülung",
              original_user_message: "Ja passt das zu mir?",
              source: "routine_inventory",
              updated_at: "2026-07-05T16:15:00.000Z",
            },
          ],
        }) as ConversationState,
      createSelectProductsTool:
        (options = {}) =>
        async (input: SelectProductsToolParams) => {
          selectedProductsCalled = true
          assert.equal(input.category, "conditioner")
          assert.deepEqual(input.targetProductIds, [])
          assert.deepEqual(input.targetProductHints, [])
          options.onResult?.(selection)
          return selection.projection
        },
      runAgentV2ResponsesTurn: async (params) => {
        await params.tools.select_products({
          category: "conditioner",
          product_request_kind: "product_detail",
          reason: "The user asks for alternatives to the active product.",
          user_request: "okay, was wären sonst Alternativen?",
          constraints: [],
          requested_product_count: 3,
          count_policy: "at_least",
          evidence_quote: "okay, was wären sonst Alternativen?",
        })
        return createAgentV2Result()
      },
    },
  )

  assert.equal(selectedProductsCalled, true)
})

test("AgentV2 production pipeline resolves redundant lookup through active routine product id", async () => {
  const hairProfile = createCompleteHairProfile()
  let lookupStatus: string | null = null
  let lookupProductId: string | null = null

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Und passt das zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-active-routine-lookup-short-circuit",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [
        {
          ...createMessage(0),
          role: "assistant",
          content:
            "Ich sehe **Syoss Intense Volume Shampoo** als dein aktuelles Shampoo in deiner Routine.",
        },
      ],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Syoss Intense Volume Shampoo",
            product_id: "syoss-volume-id",
            match_status: "matched",
            frequency_range: "weekly_3_4x",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      createAdminClient: () =>
        ({
          from: () => ({
            select: () => ({
              eq: () => ({
                limit: async () => ({ data: [{ product_id: "syoss-volume-id" }], error: null }),
              }),
            }),
          }),
        }) as never,
      createProductIntakeRepository: () =>
        ({
          loadCatalog: async () => ({
            products: [
              {
                id: "syoss-volume-id",
                name: "Syoss Intense Volume Shampoo",
                cleanName: "Intense Volume Shampoo",
                categoryKey: "shampoo",
                isActive: true,
                lifecycleStatus: "active",
                isChaarlieRecommended: false,
              },
              {
                id: "syoss-curls-id",
                name: "Syoss Intense Curls",
                cleanName: "Intense Curls",
                categoryKey: "shampoo",
                isActive: true,
                lifecycleStatus: "active",
                isChaarlieRecommended: false,
              },
            ],
            identifiers: [],
          }),
          loadBrandResolutionCatalog: async () => ({
            brands: [],
            productLines: [],
            brandAliases: [],
          }),
        }) as never,
      runAgentV2ResponsesTurn: async (params) => {
        assert.equal(params.activeResolvedProductContext?.product_id, "syoss-volume-id")
        const lookup = (await params.tools.lookup_product_candidate({
          category: "shampoo",
          brand_text: "Syoss",
          product_name_text: "Intense Volume Shampoo",
          reason: "Resolve current routine product before fit assessment.",
          evidence_quote: "Und passt das zu mir?",
        })) as { status: string; product?: { id?: string | null } | null }
        lookupStatus = lookup.status
        lookupProductId = lookup.product?.id ?? null
        return createAgentV2Result()
      },
    },
  )

  assert.equal(lookupStatus, "found_exact")
  assert.equal(lookupProductId, "syoss-volume-id")
  assert.equal(result.productLookupClarification, null)
})

test("AgentV2 production pipeline does not resolve sibling product lookups through the active product shortcut", async () => {
  const hairProfile = createCompleteHairProfile()
  let lookupStatus: string | null = null
  let lookupProductId: string | null = null

  await runAgentV2ProductionPipeline(
    {
      message: "Und was ist mit der No. 5 Bond Maintenance Variante?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-active-sibling-lookup",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_active_product_contexts: [
            {
              status: "resolved",
              product_id: "olaplex-no4-id",
              submission_id: null,
              category: "shampoo",
              brand_text: "Olaplex",
              product_name_text: "No. 4 Bond Maintenance Shampoo",
              display_name: "Olaplex No. 4 Bond Maintenance Shampoo",
              original_user_message: "Passt mein Olaplex No. 4 Bond Maintenance Shampoo zu mir?",
              source: "routine_inventory",
              updated_at: "2026-07-05T12:00:00.000Z",
            },
          ],
        }) as ConversationState,
      createProductIntakeRepository: () =>
        ({
          loadCatalog: async () => ({
            products: [
              {
                id: "olaplex-no4-id",
                name: "Olaplex No. 4 Bond Maintenance Shampoo",
                cleanName: "No. 4 Bond Maintenance Shampoo",
                categoryKey: "shampoo",
                isActive: true,
                lifecycleStatus: "active",
                isChaarlieRecommended: false,
              },
            ],
            identifiers: [],
          }),
          loadBrandResolutionCatalog: async () => ({
            brands: [{ id: "brand-olaplex", canonical_name: "Olaplex" }],
            productLines: [],
            brandAliases: [],
          }),
        }) as never,
      runAgentV2ResponsesTurn: async (params) => {
        assert.equal(params.activeResolvedProductContext?.product_id, "olaplex-no4-id")
        const lookup = (await params.tools.lookup_product_candidate({
          category: null,
          brand_text: "Olaplex",
          product_name_text: "No. 5 Bond Maintenance Conditioner",
          reason: "User asks about a sibling product variant.",
          evidence_quote: "No. 5 Bond Maintenance Variante",
        })) as { status: string; product?: { id?: string | null } | null }
        lookupStatus = lookup.status
        lookupProductId = lookup.product?.id ?? null
        return createAgentV2Result()
      },
    },
  )

  assert.notEqual(lookupStatus, "found_exact")
  assert.notEqual(lookupProductId, "olaplex-no4-id")
})

test("AgentV2 production pipeline drops routine context when user names a different product", async () => {
  const hairProfile = createCompleteHairProfile()
  let receivedActiveResolvedProductContext: unknown = "not-called"

  await runAgentV2ProductionPipeline(
    {
      message: "Passt Schwarzkopf GLISS Conditioner Liquid Silk zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-named-different-product-drops-routine-context",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: hairProfile,
        routine_inventory: [
          {
            category: "conditioner",
            product_name: "Jean&Len Colorglow Granatapfel Rose Conditioner",
            product_id: "jean-len-conditioner-id",
            match_status: "matched",
            frequency_range: "weekly_3_4x",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_active_product_contexts: [
            {
              status: "resolved",
              product_id: "jean-len-conditioner-id",
              submission_id: null,
              category: "conditioner",
              brand_text: "Jean&Len",
              product_name_text: "Colorglow Granatapfel Rose Conditioner",
              display_name: "Jean&Len Colorglow Granatapfel Rose Conditioner",
              original_user_message: "Weißt du welchen Conditioner ich gerade benutze?",
              source: "routine_inventory",
              updated_at: "2026-07-05T16:20:00.000Z",
            },
          ],
        }) as ConversationState,
      createProductIntakeRepository: () =>
        ({
          loadCatalog: async () => ({ products: [], identifiers: [] }),
          loadBrandResolutionCatalog: async () => ({
            brands: [],
            productLines: [],
            brandAliases: [],
          }),
        }) as never,
      runAgentV2ResponsesTurn: async (params) => {
        receivedActiveResolvedProductContext = params.activeResolvedProductContext
        return createAgentV2Result()
      },
    },
  )

  assert.equal(receivedActiveResolvedProductContext, null)
})

test("AgentV2 production pipeline hides owned lookup products without verified specs", async () => {
  let lookupStatus: string | null = null
  const ownedProductId = "owned-volume-shampoo"

  await runAgentV2ProductionPipeline(
    {
      message: "Passt mein Testmarke Volume Shampoo zu mir?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-owned-unverified-lookup",
      productIntakeEnabled: true,
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [
          {
            category: "shampoo",
            product_name: "Volume Shampoo",
            frequency_range: "weekly_1_2x",
            brand_text: "Testmarke",
            product_id: ownedProductId,
            product_submission_id: null,
            match_status: "matched",
          },
        ],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        createDefaultConversationState(),
      createProductIntakeRepository: () =>
        ({
          loadCatalog: async () => ({
            products: [
              {
                id: ownedProductId,
                name: "Volume Shampoo",
                brand_id: "brand-owned",
                category_key: "shampoo",
                is_active: true,
                lifecycle_status: "active",
                is_chaarlie_recommended: false,
              },
            ],
            identifiers: [],
          }),
          loadBrandResolutionCatalog: async () => ({
            brands: [{ id: "brand-owned", canonical_name: "Testmarke" }],
            product_lines: [],
            brandAliases: [{ brand_id: "brand-owned", alias: "Testmarke" }],
          }),
        }) as never,
      createAdminClient: () =>
        ({
          from: () => ({
            select: () => ({
              eq: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }) as never,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        const lookupResult = (await params.tools.lookup_product_candidate({
          category: "shampoo",
          brand_id: "brand-owned",
          product_name_text: "Volume Shampoo",
        })) as { status: string }
        lookupStatus = lookupResult.status
        return createAgentV2Result()
      },
    },
  )

  assert.equal(lookupStatus, "not_found")
})

test("AgentV2 production pipeline carries session memory through conversation state", async () => {
  const persistedMemory: AgentV2SessionMemoryWrite = {
    type: "preference",
    text: "User likes light leave-ins.",
    evidence_quote: "Ich mag leichte Leave-ins.",
    confidence: 0.9,
    ttl: "session",
    affects_recommendations: true,
    expires_at_turn: null,
  }
  const acceptedMemory: AgentV2SessionMemoryWrite = {
    type: "constraint",
    text: "User wants fewer steps.",
    evidence_quote: "Ich will weniger Schritte.",
    confidence: 0.85,
    ttl: "session",
    affects_recommendations: true,
    expires_at_turn: null,
  }
  let receivedSessionMemoryCount = 0

  const result = await runAgentV2ProductionPipeline(
    {
      message: "Was passt dann?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          agent_v2_session_memory: [persistedMemory],
        }) as ConversationState,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedSessionMemoryCount = params.userContext.sessionMemory.length
        return {
          ...createAgentV2Result(),
          accepted_session_memory_writes: [acceptedMemory],
        }
      },
    },
  )

  assert.equal(receivedSessionMemoryCount, 1)
  const nextState = result.conversationStateTransition.next_state as AgentV2ConversationStateV2
  assert.equal(nextState.agent_v2.session_memory.length, 2)
})

test("AgentV2 production pipeline ignores legacy V1 routine fields without flat AgentV2 context", async () => {
  let receivedRoutineContext: unknown = "not-called"
  let receivedRoutineLayer: unknown = "not-called"

  await runAgentV2ProductionPipeline(
    {
      message: "Welches Shampoo passt?",
      conversationId: "conversation-1",
      userId: "user-1",
      requestId: "request-1",
    },
    {
      verifyConversationOwnership,
      loadConversationHistory: async () => [],
      getUserContext: async () => ({
        profile: createCompleteHairProfile(),
        routine_inventory: [],
        relevant_memory: [],
        derived_signals: [],
        suggested_overlays: [],
        missing_profile: [],
      }),
      loadUserMemoryContext: async () => ({
        enabled: true,
        entries: [],
        promptContext: null,
        dislikedProductNames: [],
      }),
      loadConversationState: async (): Promise<ConversationState> =>
        ({
          ...createDefaultConversationState(),
          active_topic: "routine",
          routine_layer: "basics",
        }) as ConversationState,
      client: {
        responses: {
          create: async () => ({ output: [] }),
        },
      },
      runAgentV2ResponsesTurn: async (params) => {
        receivedRoutineContext = params.routineThreadContext
        receivedRoutineLayer = params.currentRoutineLayer
        return createAgentV2Result()
      },
    },
  )

  assert.equal(receivedRoutineContext, null)
  assert.equal(receivedRoutineLayer, null)
})

test("/api/chat imports only the AgentV2 production chat pipeline", async () => {
  const routeSource = await readFile("src/app/api/chat/route.ts", "utf8")
  const legacyProductionImport = "@/lib/agent/" + "legacy-production"
  const legacyProductionRunner = "runProduction" + "AgentPipeline"

  assert.match(routeSource, /@\/lib\/agent-v2\/production\/chat-pipeline/)
  assert.doesNotMatch(routeSource, /@\/lib\/agent\/production/)
  assert.doesNotMatch(routeSource, new RegExp(legacyProductionImport.replaceAll("/", "\\/")))
  assert.doesNotMatch(routeSource, new RegExp(`\\b${legacyProductionRunner}\\b`))
  assert.match(routeSource, /\brunAgentV2ProductionPipeline\b/)
})
