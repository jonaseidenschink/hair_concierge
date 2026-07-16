import { getOpenAI, getObservedOpenAI } from "@/lib/openai/client"
import { createBuildOrFixRoutineTool } from "@/lib/agent/tools/build-or-fix-routine"
import { buildCareBalanceToolContext } from "@/lib/agent/tools/care-balance-context"
import { buildTrackingToolContext } from "@/lib/agent/tools/tracking-context"
import { buildTrackingInsightContext } from "@/lib/agent/tools/tracking-insights"
import { getUserContext, type UserContextProjection } from "@/lib/agent/tools/get-user-context"
import {
  createSelectProductsTool,
  type SelectProductsToolResult,
} from "@/lib/agent/tools/select-products"
import {
  loadAgentV2ProductionConversationHistory,
  verifyAgentV2ProductionConversationOwnership,
} from "@/lib/agent-v2/production/conversation-history"
import {
  buildAgentV2GenerationMetadata,
  isAgentV2LangfuseObservationEnabled,
  observeAgentV2ToolCall,
} from "@/lib/agent-v2/production/langfuse-observability"
import { buildAgentV2ProductToolMessage } from "@/lib/agent-v2/runtime/product-tool-context"
import {
  type AgentV2AnswerMode,
  type AgentV2RoutineLayer,
  type AgentV2RoutineThreadContext,
  type AgentV2SafetyMode,
  type AgentV2SessionMemoryWrite,
  type AgentV2TerminalAnswer,
} from "@/lib/agent-v2/contracts"
import {
  buildAgentV2NamedProductContext,
  type AgentV2NamedProductContext,
} from "@/lib/agent-v2/named-product-context"
import { runAgentV2ResponsesTurn } from "@/lib/agent-v2/runtime/responses-agent"
import {
  buildActiveResolvedProductContext,
  buildPrimaryResolvedProductContext,
  mergeActiveProductContexts,
  type AgentV2ActiveProductContext,
  type AgentV2ActiveResolvedProductContext,
  type AgentV2StoredProductProjection,
  type AgentV2TrustedSelectedProductContext,
} from "@/lib/agent-v2/resolved-product-selection-adapter"
import {
  buildProductLookupTurnOutcome,
  normalizeProductLookupExecutionInput,
  type ProductLookupCatalogLoader,
  type ProductLookupExecution,
} from "@/lib/agent-v2/production/product-lookup-turn-outcome"
import { loadAgentV2AdvisorGuidance } from "@/lib/agent-v2/tools/guidance-tool"
import {
  lookupProductCandidate,
  type ProductLookupCatalog,
  type ProductLookupInput,
  type ProductLookupResult,
} from "@/lib/product-intake/product-lookup"
import {
  isProductEligibleForMode,
  productIsActive,
  productLifecycleStatus,
} from "@/lib/product-catalog/eligibility"
import { createSupabaseProductIntakeRepository } from "@/lib/product-intake/repository"
import type { ProductIntakeSubmissionRow } from "@/lib/product-intake/repository-types"
import { loadVerifiedSpecProductIds } from "@/lib/product-intake/spec-readiness"
import {
  projectRoutineForAgentV2,
  type AgentV2RoutineProjection,
} from "@/lib/agent-v2/tools/routine-projection"
import { projectSelectProductsForAgentV2 } from "@/lib/agent-v2/tools/select-products-projection"
import { loadTrackerDaysForAgent } from "@/lib/tracking/load-tracker-days"
import {
  buildAgentV2Classification,
  buildAgentV2RouterDecision,
  deriveEngineArtifacts,
  deriveIntent,
  deriveMatchedProducts,
  deriveProductCategory,
  deriveSelectedProductsResultForAnswer,
} from "@/lib/agent-v2/production/product-output"
import {
  buildRoutineThreadVisibleSteps,
  collectTrustedSurfacedProductProjections,
  mergeAgentV2SessionMemory,
  mergePriorSelectedProductProjections,
  updateAgentV2ProductionRoutineThreadContext,
} from "@/lib/agent-v2/production/session-state"
import {
  AGENT_V2_PRODUCTION_ENGINE,
  normalizeAgentV2ConversationState,
  type AgentV2ConversationStateTransition,
  type AgentV2ConversationStateV2,
} from "@/lib/agent-v2/production/persisted-session-state"
import { loadAgentV2ConversationStateForUser } from "@/lib/chat-runtime/conversation-state-store"
import { buildPipelineTraceDraft, type PipelineTraceDraft } from "@/lib/chat-runtime/debug-trace"
import { loadUserMemoryContext, type UserMemoryContext } from "@/lib/chat-runtime/user-memory"
import {
  LANGFUSE_PROMPTS,
  buildLangfusePromptConfig,
  getManagedTextPromptTemplate,
} from "@/lib/langfuse/prompts"
import type { PersistenceRoutineItemRow } from "@/lib/recommendation-engine/adapters/from-persistence"
import { buildRecommendationEngineRuntimeFromPersistence } from "@/lib/recommendation-engine/runtime"
import type { EffectiveCareContext } from "@/lib/recommendation-engine/types"
import { createAdminClient } from "@/lib/supabase/admin"
import type {
  ChatCategoryDecision,
  ChatPromptSnapshot,
  ClassificationResult,
  ConversationTurnStateTransition,
  HairProfile,
  IntentType,
  LangfusePromptReference,
  Message,
  Product,
  ProductLookupClarification,
  RouterDecision,
} from "@/lib/types"
import type { RoutineProduct } from "@/lib/vocabulary"

type RecentConversationMessage = {
  role: "user" | "assistant"
  content: string
}

type AgentV2ResponsesClient = Parameters<typeof runAgentV2ResponsesTurn>[0]["client"]
type AgentV2RuntimeToolExecutionContext = {
  effectiveCareContext?: EffectiveCareContext
}
type AgentV2ProductionTraceTiming = {
  modelMs: number | null
  toolMs: number | null
  gateMs: number | null
}

export interface PipelineParams {
  message: string
  conversationId?: string
  userId: string
  requestId: string
  productIntakeEnabled?: boolean
  trustedSelectedProductContext?: AgentV2TrustedSelectedProductContext | null
}

export interface PipelineResult {
  stream: ReadableStream<Uint8Array>
  conversationId: string
  intent: IntentType
  matchedProducts: Product[]
  routerDecision: RouterDecision
  conversationStateTransition: ConversationTurnStateTransition
  categoryDecision?: ChatCategoryDecision
  engineTrace?: import("@/lib/types").RecommendationEngineTrace
  debugTrace: PipelineTraceDraft
  visibleFailure?: boolean
  answerMode: AgentV2AnswerMode
  productIntakeOffer?: import("@/lib/types").ProductIntakeOffer | null
  productLookupClarification?: ProductLookupClarification | null
}

interface ProductionAgentV2PipelineDeps {
  client?: AgentV2ResponsesClient
  verifyConversationOwnership?: (params: {
    conversationId: string
    userId: string
  }) => Promise<boolean>
  loadConversationHistory?: (conversationId: string, userId: string) => Promise<Message[]>
  getUserContext?: (userId: string) => Promise<UserContextProjection>
  loadUserMemoryContext?: (userId: string) => Promise<UserMemoryContext>
  loadConversationState?: (params: { conversationId: string; userId: string }) => Promise<unknown>
  createSelectProductsTool?: typeof createSelectProductsTool
  createBuildOrFixRoutineTool?: typeof createBuildOrFixRoutineTool
  runAgentV2ResponsesTurn?: typeof runAgentV2ResponsesTurn
  getOpenAI?: typeof getOpenAI
  getObservedOpenAI?: typeof getObservedOpenAI
  getManagedTextPromptTemplate?: typeof getManagedTextPromptTemplate
  observeAgentV2ToolCall?: typeof observeAgentV2ToolCall
  createProductIntakeRepository?: typeof createSupabaseProductIntakeRepository
  createAdminClient?: typeof createAdminClient
  loadTrackerDays?: typeof loadTrackerDaysForAgent
}

const ROUTINE_PRODUCT_CATEGORY_VALUES = new Set<RoutineProduct>([
  "shampoo",
  "conditioner",
  "leave_in",
  "oil",
  "mask",
  "heat_protectant",
])

async function measureAsync<T>(work: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now()
  const result = await work()
  return {
    result,
    durationMs: Math.round(performance.now() - start),
  }
}

function selectProductAssessmentTargetProductIds(params: {
  productRequestKind: string | null
  category: string | null
  executions: readonly ProductLookupExecution[]
  trustedSelectedProductContext: AgentV2TrustedSelectedProductContext | null
  activeResolvedProductContext: AgentV2ActiveResolvedProductContext | null
}): string[] {
  if (params.productRequestKind !== "product_detail" || !params.category) return []

  const requestedCategory = params.category
  const ids: string[] = []
  const latestExactLookup = [...params.executions]
    .reverse()
    .find(
      (execution) =>
        execution.result.status === "found_exact" &&
        execution.result.product?.id &&
        productAssessmentCategoryMatches(
          execution.result.product.category_key ?? execution.result.category,
          requestedCategory,
        ),
    )

  if (latestExactLookup?.result.product?.id) {
    ids.push(latestExactLookup.result.product.id)
  }

  if (
    params.trustedSelectedProductContext?.selected_product.id &&
    productAssessmentCategoryMatches(
      params.trustedSelectedProductContext.selected_product.category,
      requestedCategory,
    )
  ) {
    ids.push(params.trustedSelectedProductContext.selected_product.id)
  }

  if (
    params.activeResolvedProductContext?.product_id &&
    productAssessmentCategoryMatches(
      params.activeResolvedProductContext.category,
      requestedCategory,
    )
  ) {
    ids.push(params.activeResolvedProductContext.product_id)
  }

  return [...new Set(ids)]
}

function selectProductsCategoryForAssessment(params: {
  productRequestKind: string | null
  category: string | null
  activeResolvedProductContext: AgentV2ActiveResolvedProductContext | null
}): string | null {
  if (
    params.productRequestKind === "product_detail" &&
    params.activeResolvedProductContext?.product_id &&
    params.activeResolvedProductContext.category
  ) {
    return params.activeResolvedProductContext.category
  }

  return params.category
}

function isSelectProductsAlternativesRequest(params: {
  latestUserMessage: string
  input: Record<string, unknown>
}): boolean {
  const text = [
    params.latestUserMessage,
    typeof params.input.user_request === "string" ? params.input.user_request : "",
    typeof params.input.evidence_quote === "string" ? params.input.evidence_quote : "",
  ].join(" ")
  const normalized = normalizeRoutineProductReferenceText(text)
  return /\b(?:alternative|alternativen|alternativ|andere|anderen|sonst|weitere|weiteren|statt|ersetzen|ersatz)\b/u.test(
    normalized,
  )
}

function selectProductAssessmentTargetProductHints(params: {
  targetProductIds: readonly string[]
  executions: readonly ProductLookupExecution[]
  trustedSelectedProductContext: AgentV2TrustedSelectedProductContext | null
  activeResolvedProductContext: AgentV2ActiveResolvedProductContext | null
}) {
  const targetProductIdSet = new Set(params.targetProductIds)
  const hints: Array<{ product_id: string; name: string; category: string | null }> = []

  const latestExactLookup = [...params.executions]
    .reverse()
    .find(
      (execution) =>
        execution.result.status === "found_exact" &&
        execution.result.product?.id &&
        targetProductIdSet.has(execution.result.product.id),
    )

  if (latestExactLookup?.result.product?.id) {
    hints.push({
      product_id: latestExactLookup.result.product.id,
      name: latestExactLookup.result.product.name,
      category:
        latestExactLookup.result.product.category_key ?? latestExactLookup.result.category ?? null,
    })
  }

  const trustedProduct = params.trustedSelectedProductContext?.selected_product
  if (
    trustedProduct &&
    targetProductIdSet.has(trustedProduct.id) &&
    !hints.some((hint) => hint.product_id === trustedProduct.id)
  ) {
    hints.push({
      product_id: trustedProduct.id,
      name: trustedProduct.name,
      category: trustedProduct.category,
    })
  }

  const activeProduct = params.activeResolvedProductContext
  if (
    activeProduct &&
    targetProductIdSet.has(activeProduct.product_id) &&
    !hints.some((hint) => hint.product_id === activeProduct.product_id)
  ) {
    hints.push({
      product_id: activeProduct.product_id,
      name: activeProduct.name,
      category: activeProduct.category,
    })
  }

  return hints
}

function productAssessmentCategoryMatches(
  productCategory: string | null | undefined,
  requestedCategory: string,
): boolean {
  return (productCategory ?? "").trim() === requestedCategory.trim()
}

const PRODUCT_LOOKUP_CATEGORY_TOKENS = new Set([
  "shampoo",
  "shampo",
  "conditioner",
  "spulung",
  "spuelung",
  "maske",
  "mask",
  "kur",
  "leave",
  "in",
  "haarol",
  "haaroel",
  "ol",
  "oel",
  "oil",
])

const GENERIC_PRODUCT_LOOKUP_TOKENS = new Set(["produkt", "product"])

function normalizeLookupText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLowerCase()
}

function meaningfulLookupTokens(value: string | null | undefined): string[] {
  return normalizeLookupText(value)
    .split(/\s+/u)
    .filter(
      (token) =>
        token.length > 0 &&
        !GENERIC_PRODUCT_LOOKUP_TOKENS.has(token) &&
        (token.length > 2 || /\d/u.test(token) || token === "no" || token === "nr"),
    )
}

function activeResolvedLookupInputMatches(params: {
  input: ProductLookupInput
  activeResolvedProductContext: AgentV2ActiveResolvedProductContext
}): boolean {
  const { input, activeResolvedProductContext } = params
  if (
    input.category &&
    activeResolvedProductContext.category &&
    !productAssessmentCategoryMatches(activeResolvedProductContext.category, input.category)
  ) {
    return false
  }

  const productNameTokens = meaningfulLookupTokens(input.product_name_text)
  if (productNameTokens.length === 0) return false
  if (productNameTokens.every((token) => PRODUCT_LOOKUP_CATEGORY_TOKENS.has(token))) return false

  const requestedTokens = meaningfulLookupTokens(
    [input.brand_text, input.product_name_text].filter(Boolean).join(" "),
  )
  if (requestedTokens.length === 0) return false

  const activeName = normalizeLookupText(activeResolvedProductContext.name)
  const activeTokens = new Set(activeName.split(/\s+/u).filter(Boolean))
  const matchingProductNameTokens = productNameTokens.filter((token) => activeTokens.has(token))
  if (matchingProductNameTokens.length !== productNameTokens.length) return false

  const matchingTokens = requestedTokens.filter((token) => activeTokens.has(token))
  return matchingTokens.length >= Math.min(2, requestedTokens.length)
}

function buildActiveResolvedProductLookupResult(params: {
  input: ProductLookupInput
  catalog: ProductLookupCatalog
  activeResolvedProductContext: AgentV2ActiveResolvedProductContext | null
}): ProductLookupResult | null {
  const { activeResolvedProductContext } = params
  if (!activeResolvedProductContext?.product_id) return null
  if (
    !activeResolvedLookupInputMatches({
      input: params.input,
      activeResolvedProductContext,
    })
  ) {
    return null
  }

  const product = params.catalog.products.find(
    (candidate) => candidate.id === activeResolvedProductContext.product_id,
  )
  if (!product) return null

  const category =
    product.categoryKey ??
    product.category_key ??
    activeResolvedProductContext.category ??
    params.input.category ??
    null

  return {
    status: "found_exact",
    category,
    product: {
      id: product.id,
      name: product.name,
      brand_id: product.brandId ?? product.brand_id ?? null,
      product_line_id: product.productLineId ?? product.product_line_id ?? null,
      image_url: product.imageUrl ?? product.image_url ?? null,
      category_key: category,
      is_chaarlie_recommended:
        product.isChaarlieRecommended ?? product.is_chaarlie_recommended ?? null,
    },
    candidates: [
      {
        product,
        productId: product.id,
        confidence: "exact",
        reason: "brand_name_category_exact",
        reasonCodes: ["brand_name_category_exact"],
      },
    ],
    missing_fields: [],
    intake_offer: null,
  }
}

function sumFiniteLatencies(values: readonly (number | null | undefined)[]): number | null {
  const latencies = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  )
  if (latencies.length === 0) return null
  return latencies.reduce((sum, value) => sum + value, 0)
}

function readAgentV2ModelStepLatencyMs(step: unknown): number | null {
  if (!step || typeof step !== "object" || Array.isArray(step)) return null
  const latencyMs = (step as { latency_ms?: unknown }).latency_ms
  return typeof latencyMs === "number" && Number.isFinite(latencyMs) ? latencyMs : null
}

function summarizeAgentV2ProductionTraceTiming(
  trace: Awaited<ReturnType<typeof runAgentV2ResponsesTurn>>["trace"],
): AgentV2ProductionTraceTiming {
  return {
    modelMs: sumFiniteLatencies(trace.model_steps.map(readAgentV2ModelStepLatencyMs)),
    toolMs: sumFiniteLatencies(trace.tool_calls.map((call) => call.latency_ms)),
    gateMs: trace.turn_gate?.latency_ms ?? null,
  }
}

function createTextStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    start(controller) {
      if (content.length > 0) {
        controller.enqueue(encoder.encode(content))
      }
      controller.close()
    },
  })
}

function projectRecentMessages(messages: Message[]): RecentConversationMessage[] {
  return messages.flatMap((message): RecentConversationMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") return []
    const content = message.content?.trim()
    return content ? [{ role: message.role, content }] : []
  })
}

function resolveApprovedIntakeReviewContexts(
  contexts: readonly AgentV2ActiveProductContext[],
  history: readonly Message[],
  nowIso: string,
): AgentV2ActiveProductContext[] {
  const approvedProductIdsBySubmissionId = new Map<string, string>()
  for (const message of history) {
    if (message.role !== "assistant") continue
    const review = message.message_context?.product_intake_review
    if (!review?.submission_id || !review.approved_product_id) continue
    if (review.status !== "approved" && review.status !== "matched_existing") continue
    approvedProductIdsBySubmissionId.set(review.submission_id, review.approved_product_id)
  }
  if (approvedProductIdsBySubmissionId.size === 0) return [...contexts]

  return contexts.map((context) => {
    if (context.status !== "pending_review" || !context.submission_id) return context
    const approvedProductId = approvedProductIdsBySubmissionId.get(context.submission_id)
    if (!approvedProductId) return context
    return {
      ...context,
      status: "resolved" as const,
      product_id: approvedProductId,
      updated_at: nowIso,
    }
  })
}

function buildAgentV2PromptSnapshot(params: {
  message: string
  recentMessages: RecentConversationMessage[]
  model: string
  promptRef: LangfusePromptReference
}): ChatPromptSnapshot {
  const recentMessageRoles = params.recentMessages.slice(-4).map((message) => message.role)

  return {
    kind: "agent_v2_responses",
    model: params.model,
    temperature: 0,
    prompt_ref: params.promptRef,
    system_prompt: "agent_v2_responses_care_balance",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          latest_user_message_chars: params.message.length,
          recent_message_count: params.recentMessages.length,
          recent_message_roles: recentMessageRoles,
          engine: "agent_v2_care_balance",
        }),
      },
    ],
  }
}

function buildAgentV2CareBalanceState(
  profile: HairProfile | null,
  routineItems: PersistenceRoutineItemRow[],
) {
  const runtime = buildRecommendationEngineRuntimeFromPersistence(profile, routineItems)
  const rowsWithActions = runtime.careBalance.rows.filter(
    (row) => row.recommendation !== "no_action",
  )
  return {
    context: buildCareBalanceToolContext({
      runtime,
      rows: rowsWithActions.length > 0 ? rowsWithActions : runtime.careBalance.rows,
    }),
    rows: runtime.careBalance.rows,
  }
}

function readAgentV2EffectiveCareContext(
  input: Record<string, unknown>,
): EffectiveCareContext | null {
  const value = input.effective_care_context
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const normalized = (value as { normalized?: unknown }).normalized
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return null
  const routineInventory = (normalized as { routineInventory?: unknown }).routineInventory
  if (
    !routineInventory ||
    typeof routineInventory !== "object" ||
    Array.isArray(routineInventory)
  ) {
    return null
  }
  return value as EffectiveCareContext
}

function createEmptyAgentV2HairProfile(): HairProfile {
  return {
    id: "",
    user_id: "",
    hair_texture: null,
    thickness: null,
    hair_length: null,
    density: null,
    concerns: [],
    products_used: null,
    shampoo_frequency: null,
    heat_styling: null,
    styling_tools: null,
    goals: [],
    cuticle_condition: null,
    protein_moisture_balance: null,
    scalp_type: null,
    scalp_condition: null,
    chemical_treatment: [],
    desired_volume: null,
    routine_preference: null,
    current_routine_products: [],
    towel_material: null,
    towel_technique: null,
    drying_method: null,
    brush_type: null,
    night_protection: null,
    uses_heat_protection: false,
    additional_notes: null,
    conversation_memory: null,
    created_at: "",
    updated_at: "",
  }
}

function buildAgentV2EffectiveHairProfile(
  fallback: HairProfile | null,
  effectiveContext: EffectiveCareContext | null,
): HairProfile | null {
  if (!effectiveContext) return fallback

  const profile = effectiveContext.normalized
  return {
    ...(fallback ?? createEmptyAgentV2HairProfile()),
    hair_texture: profile.hairTexture,
    hair_length: profile.hairLength,
    thickness: profile.thickness,
    density: profile.density,
    concerns: [...profile.concerns],
    shampoo_frequency: profile.shampooFrequency,
    heat_styling: profile.heatStyling,
    styling_tools: profile.stylingTools ? [...profile.stylingTools] : null,
    goals: [...profile.goals],
    cuticle_condition: profile.cuticleCondition,
    protein_moisture_balance: profile.proteinMoistureBalance,
    scalp_type: profile.scalpType,
    scalp_condition: profile.scalpCondition,
    chemical_treatment: [...profile.chemicalTreatment],
    current_routine_products: Object.values(profile.routineInventory).flatMap((item) =>
      item?.present === true && ROUTINE_PRODUCT_CATEGORY_VALUES.has(item.category as RoutineProduct)
        ? [item.category as RoutineProduct]
        : [],
    ),
    towel_material: profile.towelMaterial,
    towel_technique: profile.towelTechnique,
    drying_method: profile.dryingMethod,
    brush_type: profile.brushType,
    night_protection: profile.nightProtection ? [...profile.nightProtection] : null,
    uses_heat_protection: profile.usesHeatProtection,
  }
}

function buildAgentV2EffectiveRoutineItems(
  fallback: PersistenceRoutineItemRow[],
  effectiveContext: EffectiveCareContext | null,
): PersistenceRoutineItemRow[] {
  if (!effectiveContext) return fallback

  return Object.values(effectiveContext.normalized.routineInventory).flatMap((item) =>
    item?.present === true
      ? [
          {
            category: item.category,
            product_name: item.productName,
            frequency_range: item.frequencyBand,
            product_id: item.matchStatus === "matched" ? item.productId : null,
            product_submission_id:
              item.matchStatus === "pending_review" || item.matchStatus === "needs_more_info"
                ? item.productSubmissionId
                : null,
            match_status: item.matchStatus,
          },
        ]
      : [],
  )
}

function getMatchedRoutineProductIds(items: unknown[]): Set<string> {
  const productIds = new Set<string>()

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const matchStatus = record.match_status ?? record.matchStatus
    const productId = record.product_id ?? record.productId
    if (matchStatus === "matched" && typeof productId === "string" && productId.length > 0) {
      productIds.add(productId)
    }
  }

  return productIds
}

type PendingSubmissionIdentity = Pick<
  ProductIntakeSubmissionRow,
  "id" | "brand_text" | "product_name_text" | "category" | "status" | "updated_at"
>

function buildPendingActiveProductContextsFromRoutineInventory(
  items: unknown[],
  originalUserMessage: string,
  submissionIdentities: ReadonlyMap<string, PendingSubmissionIdentity> = new Map(),
): AgentV2ActiveProductContext[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []

    const record = item as Record<string, unknown>
    const matchStatus = record.match_status ?? record.matchStatus
    if (matchStatus !== "pending_review" && matchStatus !== "needs_more_info") return []

    const submissionId = readOptionalString(
      record.product_submission_id ?? record.productSubmissionId,
    )
    const submissionIdentity = submissionId
      ? (submissionIdentities.get(submissionId) ?? null)
      : null
    if (submissionIdentity && !PENDING_CONTEXT_SUBMISSION_STATUSES.has(submissionIdentity.status)) {
      return []
    }
    const productName =
      readOptionalString(submissionIdentity?.product_name_text) ??
      readOptionalString(
        record.product_name ??
          record.productName ??
          record.product_name_text ??
          record.productNameText,
      )
    const brandText =
      readOptionalString(submissionIdentity?.brand_text) ??
      readOptionalString(
        record.brand_text ?? record.brandText ?? record.brand_name ?? record.brandName,
      )
    const displayName = [brandText, productName].filter(Boolean).join(" ").trim()
    if (!submissionId || !displayName) return []

    return [
      {
        status: "pending_review",
        product_id: null,
        submission_id: submissionId,
        category:
          readOptionalString(submissionIdentity?.category) ?? readOptionalString(record.category),
        brand_text: brandText,
        product_name_text: productName,
        display_name: displayName,
        original_user_message: originalUserMessage,
        source: "product_intake_submission",
        updated_at:
          readOptionalString(submissionIdentity?.updated_at) ??
          readOptionalString(record.updated_at ?? record.updatedAt) ??
          new Date(0).toISOString(),
      },
    ]
  })
}

function buildMatchedRoutineActiveProductContextsFromRoutineInventory(
  items: unknown[],
  latestUserMessage: string,
  recentMessages: RecentConversationMessage[],
  latestNamedProductContext: AgentV2NamedProductContext | null,
): AgentV2ActiveProductContext[] {
  const nowIso = new Date().toISOString()
  const matchedContexts: AgentV2ActiveProductContext[] = items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []

    const record = item as Record<string, unknown>
    const matchStatus = record.match_status ?? record.matchStatus
    if (matchStatus !== "matched") return []

    const productId = readOptionalString(record.product_id ?? record.productId)
    const productName = readOptionalString(
      record.product_name ??
        record.productName ??
        record.product_name_text ??
        record.productNameText,
    )
    if (!productId || !productName) return []

    const brandText = readOptionalString(
      record.brand_text ?? record.brandText ?? record.brand_name ?? record.brandName,
    )
    const displayName = buildRoutineProductDisplayName({ brandText, productName })

    return [
      {
        status: "resolved",
        product_id: productId,
        submission_id: null,
        category: readOptionalString(record.category),
        brand_text: brandText,
        product_name_text: productName,
        display_name: displayName,
        original_user_message: latestUserMessage,
        source: "routine_inventory",
        updated_at: nowIso,
      },
    ]
  })

  return selectMatchedRoutineContextsForLatestMessage({
    contexts: matchedContexts,
    latestUserMessage,
    recentMessages,
    latestNamedProductContext,
  })
}

function isAmbiguousProductFitFollowup(message: string): boolean {
  const normalized = normalizeRoutineProductReferenceText(message)
  return (
    /\b(?:passt|geeignet|behalten|weiterverwenden|weiter verwenden|routine)\b/u.test(normalized) &&
    /\b(?:das|dieses|den|dem|der|die|er|sie|es|dazu|davon)\b/u.test(normalized)
  )
}

function selectMatchedRoutineContextsForLatestMessage(params: {
  contexts: readonly AgentV2ActiveProductContext[]
  latestUserMessage: string
  recentMessages: RecentConversationMessage[]
  latestNamedProductContext: AgentV2NamedProductContext | null
}): AgentV2ActiveProductContext[] {
  if (params.contexts.length === 0) return []

  const normalizedMessage = normalizeRoutineProductReferenceText(params.latestUserMessage)
  if (isNewProductRecommendationQuestion(normalizedMessage)) return []
  if (isActionableNamedProductContext(params.latestNamedProductContext)) {
    return uniqueContextsByProductId(
      params.contexts.filter((context) =>
        routineContextMatchesNamedProductContext(context, params.latestNamedProductContext),
      ),
    )
  }

  const referencedCategories = inferRoutineProductReferenceCategories(normalizedMessage)
  if (referencedCategories.size > 0) {
    return uniqueContextsByProductId(
      params.contexts.filter((context) =>
        routineCategoryMatchesAny(context.category, referencedCategories),
      ),
    )
  }

  if (isSameTopicRoutineProductFollowup(normalizedMessage)) {
    if (params.contexts.length === 1) return [params.contexts[0]]

    const recentAssistantText = normalizeRoutineProductReferenceText(
      params.recentMessages
        .slice(-4)
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n"),
    )
    if (!recentAssistantText) return []

    return uniqueContextsByProductId(
      params.contexts.filter((context) =>
        recentAssistantText.includes(
          normalizeRoutineProductReferenceText(context.product_name_text ?? context.display_name),
        ),
      ),
    )
  }

  return []
}

function uniqueContextsByProductId(
  contexts: readonly AgentV2ActiveProductContext[],
): AgentV2ActiveProductContext[] {
  const seen = new Set<string>()
  const unique: AgentV2ActiveProductContext[] = []
  for (const context of contexts) {
    if (!context.product_id || seen.has(context.product_id)) continue
    seen.add(context.product_id)
    unique.push(context)
  }
  return unique
}

function inferRoutineProductReferenceCategories(normalizedMessage: string): Set<string> {
  const categories = new Set<string>()

  if (/\b(?:trockenshampoo|dry shampoo)\b/u.test(normalizedMessage)) {
    categories.add("dry_shampoo")
  } else if (/\b(?:shampoo|shampoos)\b/u.test(normalizedMessage)) {
    categories.add("shampoo")
  }

  if (/\b(?:conditioner|spulung|spuelung)\b/u.test(normalizedMessage)) {
    categories.add("conditioner")
  }
  if (/\b(?:leave in|leavein)\b/u.test(normalizedMessage)) categories.add("leave_in")
  if (/\b(?:maske|haarmaske|kur)\b/u.test(normalizedMessage)) categories.add("mask")
  if (/\b(?:ol|oel|haarol|haaroel)\b/u.test(normalizedMessage)) categories.add("oil")
  if (/\b(?:bondbuilder|bond builder)\b/u.test(normalizedMessage)) categories.add("bond_builder")
  if (/\b(?:hitzeschutz|heat protectant|heat protection)\b/u.test(normalizedMessage)) {
    categories.add("heat_protectant")
  }

  return categories
}

function routineCategoryMatchesAny(
  category: string | null,
  candidates: ReadonlySet<string>,
): boolean {
  if (!category) return false
  const normalizedCategory = normalizeRoutineProductReferenceText(category).replace(/\s+/g, "_")
  for (const candidate of candidates) {
    if (normalizedCategory === candidate || normalizedCategory.includes(candidate)) return true
  }
  return false
}

function isSameTopicRoutineProductFollowup(normalizedMessage: string): boolean {
  if (!normalizedMessage) return false
  if (/\b(?:dazu|davon|damit|das|dieses|den|dem|der|die|er|sie|es)\b/u.test(normalizedMessage)) {
    return true
  }
  return /\b(?:passt|geeignet|behalten|weiterverwenden|weiter verwenden|routine|alternative|alternativen|wie oft|haufigkeit)\b/u.test(
    normalizedMessage,
  )
}

function isNewProductRecommendationQuestion(normalizedMessage: string): boolean {
  if (/\b(?:dazu|davon|damit)\b/u.test(normalizedMessage)) return false
  return /\b(?:sollte|empfiehl|empfehlen|empfehlung|neues|neuen|ersetzen)\b/u.test(
    normalizedMessage,
  )
}

function isActionableNamedProductContext(
  context: AgentV2NamedProductContext | null,
): context is AgentV2NamedProductContext {
  return Boolean(
    context?.plausible_exact_name === true && context.named_product_intent !== "background",
  )
}

function routineContextMatchesNamedProductContext(
  context: AgentV2ActiveProductContext,
  namedProductContext: AgentV2NamedProductContext | null,
): boolean {
  if (!namedProductContext) return false
  const named = normalizeRoutineProductReferenceText(namedProductContext.display_name)
  if (!named) return false

  const contextNames = [
    context.display_name,
    context.product_name_text,
    [context.brand_text, context.product_name_text].filter(Boolean).join(" "),
  ]
    .map((value) => normalizeRoutineProductReferenceText(value ?? ""))
    .filter(Boolean)

  return contextNames.some(
    (contextName) => named.includes(contextName) || contextName.includes(named),
  )
}

function normalizeRoutineProductReferenceText(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function buildRoutineProductDisplayName(params: {
  brandText: string | null
  productName: string
}): string {
  if (!params.brandText) return params.productName
  const normalizedProductName = normalizeRoutineProductReferenceText(params.productName)
  const normalizedBrandText = normalizeRoutineProductReferenceText(params.brandText)
  if (normalizedProductName.includes(normalizedBrandText)) return params.productName
  return `${params.brandText} ${params.productName}`
}

async function loadPendingSubmissionIdentities(params: {
  items: unknown[]
  userId: string
  createProductIntakeRepository?: typeof createSupabaseProductIntakeRepository
}): Promise<Map<string, PendingSubmissionIdentity>> {
  const submissionIds = Array.from(
    new Set(
      params.items.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        const matchStatus = record.match_status ?? record.matchStatus
        if (matchStatus !== "pending_review" && matchStatus !== "needs_more_info") return []
        const submissionId = readOptionalString(
          record.product_submission_id ?? record.productSubmissionId,
        )
        return submissionId ? [submissionId] : []
      }),
    ),
  )
  if (submissionIds.length === 0) return new Map()

  const repository =
    params.createProductIntakeRepository?.() ?? createSupabaseProductIntakeRepository()
  const rows = await Promise.all(
    submissionIds.map((submissionId) =>
      repository.findProductSubmission(submissionId, params.userId).catch((error) => {
        console.warn("[agent-v2] pending product submission identity lookup failed", {
          submissionId,
          error,
        })
        return null
      }),
    ),
  )

  return new Map(
    rows.flatMap((row) => {
      if (!row) return []
      return [
        [
          row.id,
          {
            id: row.id,
            brand_text: row.brand_text,
            product_name_text: row.product_name_text,
            category: row.category,
            status: row.status,
            updated_at: row.updated_at,
          },
        ],
      ]
    }),
  )
}

const PENDING_CONTEXT_SUBMISSION_STATUSES = new Set<ProductIntakeSubmissionRow["status"]>([
  "pending_review",
  "researching",
  "ready_for_review",
  "needs_more_info",
])

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function scopeLookupCatalogForUser(
  catalog: ProductLookupCatalog,
  verifiedOwnedProductIds: ReadonlySet<string>,
): ProductLookupCatalog {
  const products = catalog.products.filter(
    (product) =>
      isProductEligibleForMode(product, "general_recommendation") ||
      (verifiedOwnedProductIds.has(product.id) &&
        productIsActive(product) &&
        productLifecycleStatus(product) === "active"),
  )
  const allowedProductIds = new Set(products.map((product) => product.id))

  return {
    ...catalog,
    products,
    identifiers: catalog.identifiers?.filter((identifier) => {
      const productId = identifier.productId ?? identifier.product_id
      return Boolean(productId && allowedProductIds.has(productId))
    }),
  }
}

function buildConversationStateTransition(params: {
  previousState: AgentV2ConversationStateV2
  answer: AgentV2TerminalAnswer
  classification: ClassificationResult
  routineThreadContext: AgentV2RoutineThreadContext
  priorSelectedProductProjections: readonly AgentV2StoredProductProjection[]
  activeProductContexts?: readonly AgentV2ActiveProductContext[]
  activeResolvedProductContext?: AgentV2ActiveResolvedProductContext | null
  acceptedSessionMemoryWrites: readonly AgentV2SessionMemoryWrite[]
}): AgentV2ConversationStateTransition {
  const previousState = params.previousState
  const nextState: AgentV2ConversationStateV2 = {
    ...previousState,
    version: 2,
    engine: AGENT_V2_PRODUCTION_ENGINE,
    agent_v2: {
      routine_thread_context: params.routineThreadContext,
      prior_selected_product_projections: [...params.priorSelectedProductProjections],
      active_product_contexts:
        params.activeProductContexts === undefined
          ? previousState.agent_v2.active_product_contexts
          : [...params.activeProductContexts].slice(-3),
      active_resolved_product_context:
        params.activeResolvedProductContext === undefined
          ? buildPrimaryResolvedProductContext(previousState.agent_v2.active_product_contexts)
          : params.activeResolvedProductContext,
      session_memory: mergeAgentV2SessionMemory({
        previous: previousState.agent_v2.session_memory,
        accepted: params.acceptedSessionMemoryWrites,
      }),
    },
  }

  return {
    previous_state: previousState,
    next_state: nextState,
    reason: "agent_v2_care_balance_answer",
    changed_fields: Object.keys(nextState).filter(
      (key) =>
        previousState[key as keyof AgentV2ConversationStateV2] !==
        nextState[key as keyof AgentV2ConversationStateV2],
    ),
    classifier_override: null,
    updated_by_engine: AGENT_V2_PRODUCTION_ENGINE,
  }
}

export function classifyAgentV2ProductionSafetyMode(message: string): AgentV2SafetyMode {
  const normalized = message.toLocaleLowerCase("de-DE")

  if (
    /\b(blutet|bluten|wunde|wunden|offene kopfhaut|brennt stark|verbrennung|eiter|infektion)\b/.test(
      normalized,
    ) ||
    /haare?\s+fall(?:en|t).*(?:b(?:ue|ü)scheln|b(?:ue|ü)schelweise)/.test(normalized) ||
    /\b(pl[oö]tzlich(?:er|e|es)?\s+haarausfall|verschreibungspflichtig|rezeptpflichtig)\b/.test(
      normalized,
    ) ||
    /\b(verliere|verlierst|verliert|haarausfall)\b.{0,120}\b(extrem|sehr|viele?|wochen|nicht besser)\b/.test(
      normalized,
    ) ||
    /\b(extrem|sehr|viele?|wochen)\b.{0,120}\b(haare?|haarausfall)\b/.test(normalized)
  ) {
    return "hard_short_circuit"
  }

  const hasItchWithForegroundSymptom =
    /\bjuck(?:t|en|reiz)\b/.test(normalized) &&
    /\b(ger[oö]tet|rot|r[oö]tlich|brennt|brennen|wund|schmerzt|schmerzen|n[aä]sst|n[aä]ssen|ausschlag|offene stelle|offene stellen|schuppen|schuppt|schupp(?:ig|ige|iger|iges|enden?))\b/.test(
      normalized,
    )
  const hasForegroundSymptom =
    /\b(schmerzt|schmerzen|n[aä]sst|n[aä]ssen|ausschlag|offene stelle|offene stellen)\b/.test(
      normalized,
    ) ||
    /\bkopfhaut\b.*\bbrennt\b/.test(normalized) ||
    /\bbrennt\b.*\bkopfhaut\b/.test(normalized)
  const hasLikelyHairLossProductNameMention =
    /\banti[-\s]?(?:haarausfall|haarverlust)\b/.test(normalized) &&
    /\b(shampoo|conditioner|sp(?:ue|ü)lung|serum|tonikum|tonic|kur|maske|lotion)\b/.test(normalized)
  const hasHairLossSelfReport =
    /\b(?:ich|mir|mich|mein(?:e[rsnm]?|em)?|bei mir|habe|hab|leide|bekomme|verliere)\b.{0,80}\b(?:haarausfall|haarverlust)\b/.test(
      normalized,
    ) ||
    /\b(?:haarausfall|haarverlust)\b.{0,80}\b(?:bei mir|meinen?|meine|habe|hab|bekomme|leide)\b/.test(
      normalized,
    )
  const hasSevereHairLossMarker =
    /\b(kahle stelle|kahle stellen|kreisrund(?:er|e|es|em|en)? haarausfall|postpartum|schwangerschaft)\b/.test(
      normalized,
    )
  const hasHairLossRedFlag =
    hasSevereHairLossMarker ||
    (/\b(haarausfall|haarverlust)\b/.test(normalized) &&
      (!hasLikelyHairLossProductNameMention || hasHairLossSelfReport))

  if (hasItchWithForegroundSymptom || hasForegroundSymptom || hasHairLossRedFlag) {
    return "restricted"
  }

  return "normal"
}

function buildRoutineThreadContextFromConversationState(
  state: AgentV2ConversationStateV2,
): AgentV2RoutineThreadContext | null {
  return state.agent_v2.routine_thread_context
}

export async function runAgentV2ProductionPipeline(
  params: PipelineParams,
  deps: ProductionAgentV2PipelineDeps = {},
): Promise<PipelineResult> {
  const { message, userId, conversationId, requestId } = params
  if (!conversationId) {
    throw new Error("AgentV2 production chat requires a conversation id before orchestration.")
  }

  const createPipelineAdminClient = deps.createAdminClient ?? createAdminClient
  const startedAt = new Date().toISOString()
  const ownsConversation = await (
    deps.verifyConversationOwnership ?? verifyAgentV2ProductionConversationOwnership
  )({ conversationId, userId })

  if (!ownsConversation) {
    throw new Error("AgentV2 production conversation does not belong to user.")
  }

  const [
    { result: conversationHistory, durationMs: historyLoadMs },
    { result: userContext, durationMs: contextLoadMs },
    { result: memoryContext, durationMs: memoryLoadMs },
    { result: rawConversationState },
    { result: trackerLoad, durationMs: trackerLoadMs },
  ] = await Promise.all([
    measureAsync(() =>
      (deps.loadConversationHistory ?? loadAgentV2ProductionConversationHistory)(
        conversationId,
        userId,
      ),
    ),
    measureAsync(() => (deps.getUserContext ?? getUserContext)(userId)),
    measureAsync(() => (deps.loadUserMemoryContext ?? loadUserMemoryContext)(userId)),
    measureAsync(() =>
      deps.loadConversationState
        ? deps.loadConversationState({ conversationId, userId })
        : loadAgentV2ConversationStateForUser(createPipelineAdminClient(), {
            conversationId,
            userId,
          }),
    ),
    measureAsync(() => (deps.loadTrackerDays ?? loadTrackerDaysForAgent)(userId)),
  ])

  const conversationState = normalizeAgentV2ConversationState(rawConversationState)
  const recentMessages = projectRecentMessages(conversationHistory)
  const careBalanceState = buildAgentV2CareBalanceState(
    userContext.profile,
    userContext.routine_inventory,
  )
  const careBalanceContext = careBalanceState.context
  const trackingContext =
    trackerLoad.status === "available"
      ? buildTrackingToolContext({ days: trackerLoad.days, today: trackerLoad.referenceDate })
      : null
  const trackingInsightContext =
    trackerLoad.status === "available"
      ? buildTrackingInsightContext({
          days: trackerLoad.days,
          today: trackerLoad.referenceDate,
          careBalanceRows: careBalanceState.rows,
          activeDismissals: trackerLoad.activeDismissals,
        })
      : null
  const selectedProductResults: SelectProductsToolResult[] = []
  const selectedProductProjections: ReturnType<typeof projectSelectProductsForAgentV2>[] = []
  const productLookupExecutions: ProductLookupExecution[] = []
  let latestRoutineProjection: AgentV2RoutineProjection | null = null
  const buildRoutine = (deps.createBuildOrFixRoutineTool ?? createBuildOrFixRoutineTool)()
  const routineThreadContext = buildRoutineThreadContextFromConversationState(conversationState)
  const priorSelectedProductProjections =
    conversationState.agent_v2.prior_selected_product_projections
  const pendingSubmissionIdentities = await loadPendingSubmissionIdentities({
    items: userContext.routine_inventory,
    userId,
    createProductIntakeRepository: deps.createProductIntakeRepository,
  })
  const latestNamedProductContext = buildAgentV2NamedProductContext({
    latestMessage: params.message,
    recentMessages,
  })
  const matchedRoutineProductContexts =
    buildMatchedRoutineActiveProductContextsFromRoutineInventory(
      userContext.routine_inventory,
      message,
      recentMessages,
      latestNamedProductContext,
    )
  const pendingRoutineProductContexts = buildPendingActiveProductContextsFromRoutineInventory(
    userContext.routine_inventory,
    message,
    pendingSubmissionIdentities,
  )
  const activeProductContexts = mergeActiveProductContexts({
    previous: resolveApprovedIntakeReviewContexts(
      conversationState.agent_v2.active_product_contexts,
      conversationHistory,
      startedAt,
    ),
    next: [...pendingRoutineProductContexts, ...matchedRoutineProductContexts],
    latestMessageNamesActionableProduct: isActionableNamedProductContext(latestNamedProductContext),
  })
  const activeResolvedProductContext =
    buildActiveResolvedProductContext(params.trustedSelectedProductContext) ??
    buildPrimaryResolvedProductContext(activeProductContexts)
  const sessionMemory = conversationState.agent_v2.session_memory
  const runTurn = deps.runAgentV2ResponsesTurn ?? runAgentV2ResponsesTurn
  const productIntakeEnabled = params.productIntakeEnabled === true
  const ownedProductIds = getMatchedRoutineProductIds(userContext.routine_inventory)
  let productLookupCatalogPromise: ReturnType<ProductLookupCatalogLoader> | null = null
  const loadProductLookupCatalogs: ProductLookupCatalogLoader = () => {
    productLookupCatalogPromise ??= (async () => {
      const repository =
        deps.createProductIntakeRepository?.() ?? createSupabaseProductIntakeRepository()
      const [catalog, brandCatalog] = await Promise.all([
        repository.loadCatalog({ eligibilityMode: "intake_dedupe" }),
        repository.loadBrandResolutionCatalog(),
      ])
      const ownedCatalogProducts = catalog.products.filter((product) =>
        ownedProductIds.has(product.id),
      )
      const verifiedOwnedProductIds =
        ownedCatalogProducts.length === 0
          ? new Set<string>()
          : await loadVerifiedSpecProductIds({
              client: createPipelineAdminClient() as never,
              products: ownedCatalogProducts,
            })
      return { catalog: scopeLookupCatalogForUser(catalog, verifiedOwnedProductIds), brandCatalog }
    })()
    return productLookupCatalogPromise
  }
  const safetyMode = classifyAgentV2ProductionSafetyMode(message)
  const managedPrompt = await (deps.getManagedTextPromptTemplate ?? getManagedTextPromptTemplate)(
    LANGFUSE_PROMPTS.agentV2ResponsesCareBalance,
  )
  const useInjectedRuntimeWithoutClient =
    Boolean(deps.runAgentV2ResponsesTurn) && !deps.getOpenAI && !deps.getObservedOpenAI
  const client =
    deps.client ??
    (useInjectedRuntimeWithoutClient
      ? ({
          responses: {
            create: async () => {
              throw new Error("Injected AgentV2 runtime did not use its model client.")
            },
          },
        } satisfies AgentV2ResponsesClient)
      : isAgentV2LangfuseObservationEnabled()
        ? ((deps.getObservedOpenAI ?? getObservedOpenAI)({
            generationName: "agent-v2-responses-step",
            langfusePrompt: buildLangfusePromptConfig(managedPrompt.ref),
            generationMetadata: buildAgentV2GenerationMetadata({
              conversationId,
              requestId,
              safetyMode,
              engine: "agent_v2",
              endpoint: "responses",
              migrationMode: "agent_v2_care_balance",
            }),
          }) as unknown as AgentV2ResponsesClient)
        : ((deps.getOpenAI ?? getOpenAI)() as unknown as AgentV2ResponsesClient))
  const agentStart = performance.now()

  const result = await runTurn({
    client,
    message,
    recentMessages,
    userContext: {
      hairProfile: userContext.profile,
      routineInventory: userContext.routine_inventory,
      derivedSignals: userContext.derived_signals,
      relevantMemory: userContext.relevant_memory,
      missingProfile: userContext.missing_profile,
      sessionMemory,
      careBalanceContext,
      trackingContext,
      trackingInsightContext,
    },
    currentRoutineLayer: routineThreadContext?.active ? routineThreadContext.current_layer : null,
    routineThreadContext,
    priorSelectedProductProjections,
    activeProductContexts,
    activeResolvedProductContext,
    safetyMode,
    productIntakeEnabled,
    trustedSelectedProductContext: params.trustedSelectedProductContext ?? null,
    langfuseMode: "enabled",
    observeToolCall: deps.observeAgentV2ToolCall ?? observeAgentV2ToolCall,
    tools: {
      load_advisor_guidance: async (input) => loadAgentV2AdvisorGuidance(input),
      lookup_product_candidate: async (input) => {
        if (!productIntakeEnabled) {
          throw new Error("product intake lookup tool is disabled")
        }
        const { catalog, brandCatalog } = await loadProductLookupCatalogs()
        const lookupInput = normalizeProductLookupExecutionInput(input)
        const result =
          buildActiveResolvedProductLookupResult({
            input: lookupInput,
            catalog,
            activeResolvedProductContext,
          }) ??
          lookupProductCandidate({
            input: lookupInput,
            catalog,
            brandCatalog,
            offerId: `product-intake-${requestId}`,
            eligibilityMode: "user_visible",
            eligibilityContext: {
              ownedProductIds: new Set(catalog.products.map((product) => product.id)),
              hasVerifiedSpecs: true,
            },
          })
        productLookupExecutions.push({ input: lookupInput, result })
        return result
      },
      select_products: async (input, executionContext?: AgentV2RuntimeToolExecutionContext) => {
        const productRequestKind =
          typeof input.product_request_kind === "string" ? input.product_request_kind : null
        const requestedCategory = typeof input.category === "string" ? input.category : null
        const effectiveCategory = selectProductsCategoryForAssessment({
          productRequestKind,
          category: requestedCategory,
          activeResolvedProductContext,
        })
        const isAlternativesRequest = isSelectProductsAlternativesRequest({
          latestUserMessage: message,
          input,
        })
        const effectiveCareContext =
          executionContext?.effectiveCareContext ?? readAgentV2EffectiveCareContext(input)
        const effectiveHairProfile = buildAgentV2EffectiveHairProfile(
          userContext.profile,
          effectiveCareContext,
        )
        const effectiveRoutineItems = buildAgentV2EffectiveRoutineItems(
          userContext.routine_inventory,
          effectiveCareContext,
        )
        const productToolMessage = buildAgentV2ProductToolMessage({
          latestMessage: message,
          recentMessages,
        })
        const targetProductIds = isAlternativesRequest
          ? []
          : selectProductAssessmentTargetProductIds({
              productRequestKind,
              category: effectiveCategory,
              executions: productLookupExecutions,
              trustedSelectedProductContext: params.trustedSelectedProductContext ?? null,
              activeResolvedProductContext,
            })
        const targetProductHints = selectProductAssessmentTargetProductHints({
          targetProductIds,
          executions: productLookupExecutions,
          trustedSelectedProductContext: params.trustedSelectedProductContext ?? null,
          activeResolvedProductContext,
        })
        let rawResult: SelectProductsToolResult | null = null
        const selectProductsForCall = (deps.createSelectProductsTool ?? createSelectProductsTool)({
          onResult: (result) => {
            rawResult = result
          },
        })
        const projection = await selectProductsForCall({
          category: effectiveCategory as Parameters<typeof selectProductsForCall>[0]["category"],
          message: productToolMessage,
          hairProfile: effectiveHairProfile,
          memoryContext,
          routineItems: effectiveRoutineItems,
          effectiveCareContext,
          targetProductIds,
          targetProductHints,
        })
        const resultForProjection =
          rawResult ??
          ({
            projection,
            products: [],
            effectiveHairProfile,
            runtime: {} as SelectProductsToolResult["runtime"],
          } satisfies SelectProductsToolResult)
        selectedProductResults.push(resultForProjection)
        const agentProjection = projectSelectProductsForAgentV2(resultForProjection, {
          includeCareBalanceContext: true,
        })
        selectedProductProjections.push(agentProjection)
        return agentProjection
      },
      build_or_fix_routine: async (
        input,
        executionContext?: AgentV2RuntimeToolExecutionContext,
      ) => {
        const effectiveCareContext =
          executionContext?.effectiveCareContext ?? readAgentV2EffectiveCareContext(input)
        const effectiveHairProfile = buildAgentV2EffectiveHairProfile(
          userContext.profile,
          effectiveCareContext,
        )
        const effectiveRoutineItems = buildAgentV2EffectiveRoutineItems(
          userContext.routine_inventory,
          effectiveCareContext,
        )
        const mutationKind = typeof input.mutation_kind === "string" ? input.mutation_kind : null
        const projection = await buildRoutine({
          objective:
            input.objective === "build_routine" || input.objective === "fix_routine"
              ? input.objective
              : "build_routine",
          message,
          hairProfile: effectiveHairProfile,
          layer: input.requested_layer as Parameters<typeof buildRoutine>[0]["layer"],
          requestedCategory: input.requested_category as Parameters<
            typeof buildRoutine
          >[0]["requestedCategory"],
          mutationKind: mutationKind as Parameters<typeof buildRoutine>[0]["mutationKind"],
          routineItems: effectiveRoutineItems,
          effectiveCareContext,
        })
        const agentProjection = projectRoutineForAgentV2(projection, {
          requestedLayer: input.requested_layer as AgentV2RoutineLayer,
          includeCareBalanceContext: true,
        })
        latestRoutineProjection = agentProjection
        return agentProjection
      },
    },
  })
  const agentMs = Math.round(performance.now() - agentStart)
  const agentTiming = summarizeAgentV2ProductionTraceTiming(result.trace)

  const productLookupOutcome = await buildProductLookupTurnOutcome({
    productIntakeEnabled,
    safetyMode,
    activeProductContexts,
    activeResolvedProductContext,
    trustedSelectedProductContext: params.trustedSelectedProductContext,
    namedProductContext: latestNamedProductContext,
    executions: productLookupExecutions,
    trace: result.trace,
    finalAnswer: result.final_answer,
    latestUserMessage: params.message,
    loadProductLookupCatalogs,
    requestId,
  })
  const {
    answer,
    visibleFailure,
    productIntakeOffer,
    productLookupClarification,
    trustedSelectedProductProjection,
  } = productLookupOutcome
  const intent = deriveIntent(answer)
  const productCategory = visibleFailure ? null : deriveProductCategory(answer)
  const routerDecision = buildAgentV2RouterDecision({ answer, visibleFailure })
  const classification = buildAgentV2Classification({
    answer,
    intent,
    productCategory,
    routerDecision,
  })
  const matchedProducts = visibleFailure
    ? []
    : deriveMatchedProducts({ answer, selectedProductResults })
  const selectedProductsResultForAnswer = visibleFailure
    ? null
    : deriveSelectedProductsResultForAnswer({ answer, selectedProductResults })
  const { categoryDecision, engineTrace } = deriveEngineArtifacts(selectedProductsResultForAnswer)
  const exposedCategoryDecision = visibleFailure ? undefined : categoryDecision
  const exposedEngineTrace = visibleFailure ? undefined : engineTrace
  const attachmentMode = matchedProducts.length > 0 ? "cards" : "text_only"
  const prompt = buildAgentV2PromptSnapshot({
    message,
    recentMessages,
    model: result.trace.model,
    promptRef: managedPrompt.ref,
  })
  const visibleRoutineSteps = buildRoutineThreadVisibleSteps(
    latestRoutineProjection as AgentV2RoutineProjection | null,
  )
  const nextRoutineThreadContext = updateAgentV2ProductionRoutineThreadContext({
    previous: routineThreadContext,
    answer,
    message,
    routineProjection: latestRoutineProjection,
    visibleFailure,
  })
  const nextPriorSelectedProductProjections = visibleFailure
    ? priorSelectedProductProjections
    : mergePriorSelectedProductProjections({
        previous: priorSelectedProductProjections,
        next: [
          ...collectTrustedSurfacedProductProjections({
            projections: selectedProductProjections,
            answer,
          }),
          ...(trustedSelectedProductProjection ? [trustedSelectedProductProjection] : []),
        ],
      })
  const persistedVisibleRoutineSteps =
    nextRoutineThreadContext.visible_steps.length > 0
      ? nextRoutineThreadContext.visible_steps
      : visibleRoutineSteps
  const conversationStateTransition = buildConversationStateTransition({
    previousState: conversationState,
    answer,
    classification,
    routineThreadContext: {
      ...nextRoutineThreadContext,
      visible_steps: persistedVisibleRoutineSteps,
    },
    priorSelectedProductProjections: nextPriorSelectedProductProjections,
    activeProductContexts: productLookupOutcome.nextActiveProductContexts,
    activeResolvedProductContext: productLookupOutcome.nextActiveResolvedProductContext,
    acceptedSessionMemoryWrites: result.accepted_session_memory_writes,
  })
  const debugTrace = buildPipelineTraceDraft({
    request_id: requestId,
    started_at: startedAt,
    user_message: `[agent_v2_user_message chars=${message.length}]`,
    conversation_id: conversationId,
    intent,
    product_category: productCategory,
    conversation_history_count: conversationHistory.length,
    classification,
    router_decision: routerDecision,
    conversation_state: conversationStateTransition,
    clarification_questions:
      routerDecision.response_mode === "clarify_only" && routerDecision.clarification_reason
        ? [routerDecision.clarification_reason]
        : [],
    hair_profile_snapshot: userContext.profile,
    memory_context: memoryContext.promptContext,
    should_plan_routine: answer.answer_mode === "routine",
    category_decision: exposedCategoryDecision,
    engine_trace: exposedEngineTrace,
    matched_products: matchedProducts,
    classification_prompt_ref: managedPrompt.ref,
    prompt,
    response_composition: {
      path: "agent_v2_responses",
      migration_mode: "agent_v2_care_balance",
      fallback_reason: null,
      rendering_path: null,
      plan_type: answer.answer_mode,
      attachment_mode: attachmentMode,
    },
    engine_variant: "agent_v2_care_balance",
    agent_v2_trace: {
      ...result.trace,
      tracker_context: {
        load_status: trackerLoad.status,
        load_reason: trackerLoad.reason,
        logged_day_count: trackerLoad.days.length,
        insight_count: trackingInsightContext?.insights.length ?? 0,
        load_ms: trackerLoadMs,
      },
      routine_thread_context: {
        ...nextRoutineThreadContext,
        visible_steps: persistedVisibleRoutineSteps,
      },
    },
    latencies_ms: {
      classification_ms: 0,
      hair_profile_load_ms: contextLoadMs,
      routine_inventory_load_ms: 0,
      memory_load_ms: memoryLoadMs,
      routine_planning_ms: 0,
      history_load_ms: historyLoadMs,
      router_ms: 0,
      conversation_create_ms: 0,
      product_matching_ms: 0,
      prompt_build_ms: 0,
      stream_setup_ms: 0,
      agent_runtime_ms: agentMs,
      agent_turn_gate_ms: agentTiming.gateMs,
      agent_model_ms: agentTiming.modelMs,
      agent_tool_ms: agentTiming.toolMs,
    },
  })

  return {
    stream: createTextStream(String(answer.payload.user_facing_answer_de ?? "")),
    conversationId,
    intent,
    matchedProducts,
    conversationStateTransition,
    routerDecision,
    categoryDecision: exposedCategoryDecision,
    engineTrace: exposedEngineTrace,
    debugTrace,
    visibleFailure,
    answerMode: answer.answer_mode,
    productIntakeOffer,
    productLookupClarification,
  }
}
