"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown } from "lucide-react"
import { Header } from "@/components/layout/header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ManageSubscriptionButton } from "@/components/profile/manage-subscription-button"
import { ProfilePlanSwitcher } from "@/components/profile/profile-plan-switcher"
import type { MembershipManagementState } from "@/lib/billing/types"
import { formatBillingDate } from "@/lib/billing/display"
import { intervalLabel } from "@/lib/billing/plan-change"
import type { OnboardingStep } from "@/lib/onboarding/store"
import {
  coerceUserProductUsageRows,
  createProductRows,
  getProductCompletionLabel,
  USER_PRODUCT_USAGE_WITH_PRODUCT_SELECT,
  type UserProductUsageRow,
} from "@/lib/profile/product-usage-rows"
import {
  PROFILE_FIELD_CONFIG,
  PROFILE_SECTION_META,
  type ProfileEditTarget,
  type ProfileFieldConfig,
  type ProfileFieldValue,
  type ProfileJourneySectionKey,
} from "@/lib/profile/section-config"
import { createClient } from "@/lib/supabase/client"
import type { ChemicalTreatment, HairProfile, ProfileConcern, UserMemoryEntry } from "@/lib/types"
import {
  CHEMICAL_TREATMENT_LABELS,
  PROFILE_CONCERN_LABELS,
  HAIR_DENSITY_OPTIONS,
  HAIR_TEXTURE_OPTIONS,
  HAIR_THICKNESS_OPTIONS,
  SCALP_CONDITION_LABELS,
  SCALP_TYPE_LABELS,
} from "@/lib/types"
import { CHEMICAL_TREATMENTS, fehler, HAIR_LENGTH_OPTIONS } from "@/lib/vocabulary"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/auth-provider"
import { useToast } from "@/providers/toast-provider"

type MemoryApiResponse = {
  settings: { memory_enabled: boolean }
  entries: UserMemoryEntry[]
}

function membershipStatusLabel(state: MembershipManagementState) {
  if (state.kind === "payment_problem") return "Zahlung ausstehend"
  if (state.kind === "canceled_at_period_end") return "Verlängerung gekündigt"
  if (state.kind === "manual_grant") return "Aktiver Sonderzugang"
  if (state.kind === "legacy_unmanageable") return "Aktiv"
  if (state.kind === "uncertain") return "Status wird geprüft"
  return "Aktiv"
}

type StructuredField = ProfileFieldConfig & { value: ProfileFieldValue }

type JourneyField = {
  key: string
  label: string
  value: ProfileFieldValue
  editTarget: ProfileEditTarget | null
}

type QuizDraft = {
  hair_texture: string
  thickness: string
  density: string
  hair_length: string
  cuticle_condition: string
  protein_moisture_balance: string
  chemical_treatment: ChemicalTreatment[]
  scalp_type: string
  scalp_condition: string
  concerns: ProfileConcern[]
}

type QuizSaveNotice =
  | { variant: "success"; title: string; description: string }
  | { variant: "error"; title: string; description: string }

type SectionPreview = {
  title: string
  text: string
}

type ProfileSectionSummary = {
  key: ProfileJourneySectionKey
  title: string
  status: string
  isComplete: boolean
  preview?: SectionPreview
}

const SECTION_META_BY_KEY = Object.fromEntries(
  PROFILE_SECTION_META.map((meta) => [meta.key, meta]),
) as Record<ProfileJourneySectionKey, (typeof PROFILE_SECTION_META)[number]>

const QUIZ_SURFACE_OPTIONS = [
  { value: "smooth", label: "Glatt wie Glas" },
  { value: "slightly_rough", label: "Leicht uneben" },
  { value: "rough", label: "Rau und huckelig" },
]

const QUIZ_ELASTICITY_OPTIONS = [
  { value: "stretches_bounces", label: "Dehnt sich und geht zurück" },
  { value: "stretches_stays", label: "Dehnt sich, bleibt ausgeleiert" },
  { value: "snaps", label: "Reißt sofort" },
]

const QUIZ_SCALP_TYPE_OPTIONS = [
  { value: "oily", label: SCALP_TYPE_LABELS.oily },
  { value: "balanced", label: SCALP_TYPE_LABELS.balanced },
  { value: "dry", label: SCALP_TYPE_LABELS.dry },
]

const QUIZ_SCALP_CONDITION_OPTIONS = [
  { value: "dandruff", label: SCALP_CONDITION_LABELS.dandruff },
  { value: "dry_flakes", label: SCALP_CONDITION_LABELS.dry_flakes },
  { value: "irritated", label: SCALP_CONDITION_LABELS.irritated },
]

const QUIZ_CHEMICAL_TREATMENT_OPTIONS: Array<{ value: ChemicalTreatment; label: string }> =
  CHEMICAL_TREATMENTS.map((value) => ({
    value,
    label: CHEMICAL_TREATMENT_LABELS[value],
  }))

const QUIZ_CONCERN_OPTIONS: Array<{ value: ProfileConcern; label: string }> = [
  { value: "hair_damage", label: PROFILE_CONCERN_LABELS.hair_damage },
  { value: "split_ends", label: PROFILE_CONCERN_LABELS.split_ends },
  { value: "breakage", label: PROFILE_CONCERN_LABELS.breakage },
  { value: "dryness", label: PROFILE_CONCERN_LABELS.dryness },
  { value: "frizz", label: PROFILE_CONCERN_LABELS.frizz },
  { value: "tangling", label: PROFILE_CONCERN_LABELS.tangling },
]

function buildOnboardingHref(
  step: OnboardingStep,
  options?: { category?: string | null; singleStep?: boolean },
) {
  const params = new URLSearchParams({
    step,
    returnTo: "/profile",
  })

  if (options?.category) {
    params.set("category", options.category)
  }

  if (options?.singleStep) {
    params.set("editMode", "single-step")
  }

  return `/onboarding?${params.toString()}`
}

function createQuizDraft(profile: HairProfile | null): QuizDraft {
  return {
    hair_texture: profile?.hair_texture ?? "",
    thickness: profile?.thickness ?? "",
    density: profile?.density ?? "",
    hair_length: profile?.hair_length ?? "",
    cuticle_condition: profile?.cuticle_condition ?? "",
    protein_moisture_balance: profile?.protein_moisture_balance ?? "",
    chemical_treatment: profile?.chemical_treatment ?? [],
    scalp_type: profile?.scalp_type ?? "",
    scalp_condition: profile?.scalp_condition ?? "",
    concerns: profile?.concerns ?? [],
  }
}

function createLocalHairProfile(
  currentProfile: HairProfile | null,
  userId: string,
  fields: Partial<HairProfile>,
): HairProfile {
  const now = fields.updated_at ?? new Date().toISOString()
  const hasHairLengthOverride = Object.prototype.hasOwnProperty.call(fields, "hair_length")

  return {
    id: currentProfile?.id ?? `local-${userId}`,
    user_id: userId,
    hair_texture: currentProfile?.hair_texture ?? null,
    thickness: currentProfile?.thickness ?? null,
    density: currentProfile?.density ?? null,
    concerns: currentProfile?.concerns ?? [],
    products_used: currentProfile?.products_used ?? null,
    shampoo_frequency: currentProfile?.shampoo_frequency ?? null,
    heat_styling: currentProfile?.heat_styling ?? null,
    styling_tools: currentProfile?.styling_tools ?? null,
    goals: currentProfile?.goals ?? [],
    cuticle_condition: currentProfile?.cuticle_condition ?? null,
    protein_moisture_balance: currentProfile?.protein_moisture_balance ?? null,
    scalp_type: currentProfile?.scalp_type ?? null,
    scalp_condition: currentProfile?.scalp_condition ?? null,
    chemical_treatment: currentProfile?.chemical_treatment ?? [],
    desired_volume: currentProfile?.desired_volume ?? null,
    routine_preference: currentProfile?.routine_preference ?? null,
    current_routine_products: currentProfile?.current_routine_products ?? null,
    towel_material: currentProfile?.towel_material ?? null,
    towel_technique: currentProfile?.towel_technique ?? null,
    drying_method: currentProfile?.drying_method ?? null,
    brush_type: currentProfile?.brush_type ?? null,
    night_protection: currentProfile?.night_protection ?? null,
    uses_heat_protection: currentProfile?.uses_heat_protection ?? false,
    additional_notes: currentProfile?.additional_notes ?? null,
    conversation_memory: currentProfile?.conversation_memory ?? null,
    created_at: currentProfile?.created_at ?? now,
    updated_at: now,
    ...fields,
    hair_length: hasHairLengthOverride
      ? (fields.hair_length ?? null)
      : (currentProfile?.hair_length ?? null),
  }
}

function toggleChemicalTreatment(
  currentValues: ChemicalTreatment[],
  treatment: ChemicalTreatment,
): ChemicalTreatment[] {
  if (treatment === "natural") {
    return currentValues.includes("natural") ? [] : ["natural"]
  }

  const withoutNatural = currentValues.filter((value) => value !== "natural")

  if (withoutNatural.includes(treatment)) {
    return withoutNatural.filter((value) => value !== treatment)
  }

  const next = [...withoutNatural, treatment]
  return CHEMICAL_TREATMENTS.filter((value) => value !== "natural" && next.includes(value))
}

function hasProfileFieldValue(value: ProfileFieldValue): boolean {
  return value !== null && (!Array.isArray(value) || value.length > 0)
}

function toggleConcern(currentValues: ProfileConcern[], concern: ProfileConcern): ProfileConcern[] {
  if (currentValues.includes(concern)) {
    return currentValues.filter((value) => value !== concern)
  }

  if (currentValues.length >= 3) {
    return currentValues
  }

  return [...currentValues, concern]
}

function getCompletionLabel(filled: number, total: number) {
  if (total === 0 || filled === 0) return "Offen"
  return `${filled}/${total} vollständig`
}

function getOpenItemsTitle(count: number, singular: string, plural: string) {
  const label = count === 1 ? singular : plural
  return `Noch ${count} ${label} offen`
}

function SectionStatusBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className="border-primary/15 bg-primary/[0.05] px-3 py-1 text-xs font-medium text-primary"
    >
      {label}
    </Badge>
  )
}

function ProductReviewStatusBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className="w-fit border-amber-300/50 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800"
    >
      {label}
    </Badge>
  )
}

function SectionHeader({
  title,
  description,
  status,
  controls,
  isOpen = true,
  preview,
  size = "lg",
}: {
  title: string
  description: string
  status: string
  controls?: ReactNode
  isOpen?: boolean
  preview?: SectionPreview
  size?: "lg" | "sm"
}) {
  const titleClass =
    size === "sm"
      ? "font-[family-name:var(--font-display)] text-xl font-medium leading-tight text-[var(--text-heading)]"
      : "font-[family-name:var(--font-display)] text-2xl font-medium leading-tight text-[var(--text-heading)]"

  return (
    <div>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className={titleClass}>{title}</h2>
            <SectionStatusBadge label={status} />
          </div>
          <CardDescription className="mt-2 max-w-2xl text-sm">{description}</CardDescription>
        </div>
        {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
      </div>

      {!isOpen && preview ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-muted/35 p-4">
          <p className="text-sm font-semibold text-[var(--text-heading)]">{preview.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{preview.text}</p>
        </div>
      ) : null}
    </div>
  )
}

function SectionGridSkeleton({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn("grid gap-4", className)}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-xl border border-border/70 bg-card/70 p-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-3 w-48" />
          <Skeleton className="mt-5 h-8 w-full" />
        </div>
      ))}
    </div>
  )
}

function ProfileFieldCard({
  field,
  children,
  onClick,
  className,
  tone = "default",
}: {
  field: JourneyField
  children?: ReactNode
  onClick?: () => void
  className?: string
  tone?: "default" | "attention"
}) {
  const interactive = Boolean(onClick)

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        "rounded-[22px] border border-primary/10 bg-[hsl(var(--background))]/70 p-5 transition-colors",
        interactive
          ? "cursor-pointer hover:border-primary/30 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          : "",
        tone === "attention" ? "border-[var(--brand-coral)]/35 bg-[var(--brand-coral-light)]" : "",
        className,
      )}
    >
      <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {field.label}
      </p>
      {children ?? <ProfileFieldValue value={field.value} />}
    </div>
  )
}

function ProfileFieldValue({
  value,
  emptyLabel = "Noch offen",
}: {
  value: ProfileFieldValue
  emptyLabel?: string
}) {
  if (value == null || (Array.isArray(value) && value.length === 0)) {
    return (
      <div className="flex flex-wrap gap-2">
        <Badge
          variant="outline"
          className="rounded-full border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground"
        >
          {emptyLabel}
        </Badge>
      </div>
    )
  }

  const items = Array.isArray(value) ? value : [value]

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge
          key={item}
          variant="outline"
          className="rounded-full border-primary/20 bg-background px-3 py-1 text-xs font-semibold text-[var(--text-heading)]"
        >
          {item}
        </Badge>
      ))}
    </div>
  )
}

function InlinePromptCard({
  title,
  text,
  action,
}: {
  title: string
  text: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/40 p-4">
      <p className="text-sm font-semibold text-[var(--text-heading)]">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

function QuizEditorField({
  title,
  text,
  children,
  className,
}: {
  title: string
  text: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("rounded-xl border border-border/80 bg-card/80 p-4", className)}>
      <p className="text-sm font-semibold text-[var(--text-heading)]">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text}</p>
      <div className="mt-4">{children}</div>
    </div>
  )
}

export default function ProfilePage() {
  const router = useRouter()
  const { user, profile, loading: authLoading } = useAuth()
  const { toast } = useToast()
  const supabase = useMemo(() => createClient(), [])
  const userId = user?.id ?? null

  const [hairProfile, setHairProfile] = useState<HairProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [productUsage, setProductUsage] = useState<UserProductUsageRow[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [quizEditing, setQuizEditing] = useState(false)
  const [quizSaving, setQuizSaving] = useState(false)
  const [quizDraft, setQuizDraft] = useState<QuizDraft>(() => createQuizDraft(null))
  const [quizNotice, setQuizNotice] = useState<QuizSaveNotice | null>(null)
  const [pendingQuizFocusKey, setPendingQuizFocusKey] = useState<string | null>(null)
  const quizFieldRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [openSections, setOpenSections] = useState<ProfileJourneySectionKey[]>(["memory"])
  const [memoryEntries, setMemoryEntries] = useState<UserMemoryEntry[]>([])
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [memoryLoading, setMemoryLoading] = useState(true)
  const [memorySaving, setMemorySaving] = useState(false)
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState("")
  const [membershipState, setMembershipState] = useState<MembershipManagementState | null>(null)
  const [membershipLoading, setMembershipLoading] = useState(true)
  const [membershipError, setMembershipError] = useState(false)
  const [membershipReloadKey, setMembershipReloadKey] = useState(0)
  const [membershipReactivated, setMembershipReactivated] = useState(false)
  const [planChangeNotice, setPlanChangeNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function loadHairProfile() {
      if (!userId) {
        if (active) {
          setHairProfile(null)
          setProfileLoading(false)
        }
        return
      }

      setProfileLoading(true)

      try {
        const { data, error } = await supabase
          .from("hair_profiles")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle()

        if (error) throw error
        if (!active) return

        setHairProfile(data ?? null)
      } catch (error) {
        console.error("Error loading hair profile:", error)
        if (active) {
          setHairProfile(null)
        }
      } finally {
        if (active) {
          setProfileLoading(false)
        }
      }
    }

    loadHairProfile()

    return () => {
      active = false
    }
  }, [supabase, userId])

  useEffect(() => {
    let active = true

    async function loadMembershipState() {
      if (!userId) {
        if (active) {
          setMembershipLoading(false)
          setMembershipError(true)
        }
        return
      }

      setMembershipLoading(true)
      setMembershipError(false)
      try {
        const response = await fetch("/api/billing/membership", { cache: "no-store" })
        if (!response.ok) throw new Error(`membership state request failed: ${response.status}`)
        const body = (await response.json()) as { state?: MembershipManagementState }
        if (!body.state || typeof body.state.kind !== "string") {
          throw new Error("membership access response invalid")
        }
        if (!active) return
        setMembershipState(body.state)
      } catch (error) {
        console.error("Error loading membership state:", error)
        if (active) {
          setMembershipState({ kind: "uncertain" })
          setMembershipError(true)
        }
      } finally {
        if (active) setMembershipLoading(false)
      }
    }

    loadMembershipState()

    return () => {
      active = false
    }
  }, [membershipReloadKey, userId])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const membership = params.get("membership")
    setMembershipReactivated(membership === "reactivated")
    const planChange = params.get("plan-change")
    setPlanChangeNotice(
      planChange === "cancelled"
        ? "Der Wechsel wurde nicht bestätigt. Dein bisheriger Plan bleibt unverändert."
        : planChange === "reconciling"
          ? "Deine Bestätigung wird noch mit PayPal abgeglichen. Du musst nichts weiter tun."
          : planChange === "scheduled"
            ? "Dein Planwechsel wurde bestätigt."
            : null,
    )
  }, [])

  useEffect(() => {
    let active = true

    async function loadProductUsage() {
      if (!userId) {
        if (active) {
          setProductUsage([])
          setProductsLoading(false)
        }
        return
      }

      setProductsLoading(true)

      try {
        const { data, error } = await supabase
          .from("user_product_usage")
          .select(USER_PRODUCT_USAGE_WITH_PRODUCT_SELECT)
          .eq("user_id", userId)

        if (error) throw error
        if (!active) return

        setProductUsage(coerceUserProductUsageRows(data))
      } catch (error) {
        console.error("Error loading product usage:", error)
        if (active) {
          setProductUsage([])
        }
      } finally {
        if (active) {
          setProductsLoading(false)
        }
      }
    }

    loadProductUsage()

    return () => {
      active = false
    }
  }, [supabase, userId])

  useEffect(() => {
    if (!quizEditing) {
      setQuizDraft(createQuizDraft(hairProfile))
    }
  }, [hairProfile, quizEditing])

  useEffect(() => {
    if (quizNotice?.variant !== "success") return

    const timeoutId = window.setTimeout(() => {
      setQuizNotice((current) => (current?.variant === "success" ? null : current))
    }, 4000)

    return () => window.clearTimeout(timeoutId)
  }, [quizNotice])

  useEffect(() => {
    if (!quizEditing || !pendingQuizFocusKey) return

    const target = quizFieldRefs.current[pendingQuizFocusKey]
    if (!target) return

    const frameId = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" })
      // Move focus into the editor so keyboard users land on a control.
      const focusable = target.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
      setPendingQuizFocusKey(null)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [pendingQuizFocusKey, quizEditing])

  useEffect(() => {
    let active = true

    async function loadMemory() {
      if (!userId) {
        if (active) {
          setMemoryEntries([])
          setMemoryLoading(false)
        }
        return
      }

      setMemoryLoading(true)

      try {
        const response = await fetch("/api/memory")
        if (!response.ok) throw new Error("Memory konnte nicht geladen werden")

        const data = (await response.json()) as MemoryApiResponse
        if (!active) return

        setMemoryEnabled(data.settings.memory_enabled)
        setMemoryEntries(data.entries ?? [])
      } catch (error) {
        console.error("Error loading memory:", error)
      } finally {
        if (active) {
          setMemoryLoading(false)
        }
      }
    }

    loadMemory()

    return () => {
      active = false
    }
  }, [userId])

  const structuredFields = useMemo<StructuredField[]>(
    () =>
      PROFILE_FIELD_CONFIG.map((field) => ({
        ...field,
        value: field.getValue(hairProfile),
      })),
    [hairProfile],
  )

  const quizFields = structuredFields.filter((field) => field.sectionKey === "quiz")
  const stylingFields = structuredFields.filter((field) => field.sectionKey === "styling")
  const routineFields = structuredFields.filter((field) => field.sectionKey === "routine")
  const goalsFields = structuredFields.filter((field) => field.sectionKey === "goals")
  const goalsField = goalsFields[0] ?? null
  const productRows = useMemo(() => createProductRows(productUsage), [productUsage])

  const quizFilled = quizFields.filter((field) => hasProfileFieldValue(field.value))
  const stylingFilled = stylingFields.filter((field) => hasProfileFieldValue(field.value))
  const routineFilled = routineFields.filter((field) => hasProfileFieldValue(field.value))
  const goalsFilled = goalsFields.filter((field) => hasProfileFieldValue(field.value))
  const selectedProductCategories = productRows.map((row) => row.categoryLabel)
  const incompleteProductRows = productRows.filter((row) => row.needsUserDetails)

  const quizStatus = profileLoading
    ? "Wird geladen"
    : getCompletionLabel(quizFilled.length, quizFields.length)
  const productsStatus = productsLoading
    ? "Wird geladen"
    : getProductCompletionLabel(productRows, Boolean(profile?.onboarding_completed))
  const stylingStatus = profileLoading
    ? "Wird geladen"
    : getCompletionLabel(stylingFilled.length, stylingFields.length)
  const routineStatus = profileLoading
    ? "Wird geladen"
    : getCompletionLabel(routineFilled.length, routineFields.length)
  const goalsStatus = profileLoading
    ? "Wird geladen"
    : getCompletionLabel(goalsFilled.length, goalsFields.length)
  const memoryStatus = memoryLoading ? "Wird geladen" : memoryEnabled ? "Aktiv" : "Pausiert"

  const memoryEntryLabel = memoryEntries.length === 1 ? "Erinnerung" : "Erinnerungen"
  const memorySectionSummary: ProfileSectionSummary = {
    key: "memory",
    title: SECTION_META_BY_KEY.memory.title,
    status: memoryStatus,
    isComplete: true,
    preview: memoryLoading
      ? {
          title: "Erinnerungen werden geladen",
          text: "Gleich siehst du, welche langfristigen Hinweise derzeit gespeichert sind.",
        }
      : !memoryEnabled
        ? {
            title: "Erinnerungen pausiert",
            text: "Aktiviere die Erinnerungen wieder, wenn langfristige Hinweise aus dem Chat gespeichert werden sollen.",
          }
        : memoryEntries.length === 0
          ? {
              title: "Noch keine gespeicherten Erinnerungen",
              text: "Wenn du im Chat konkrete Haarpflege-Infos gibst, können sie hier als langfristiger Kontext auftauchen.",
            }
          : {
              title: `${memoryEntries.length} ${memoryEntryLabel} gespeichert`,
              text: "Hier kannst du prüfen, bearbeiten oder löschen, was ich aus unseren Gesprächen behalten darf.",
            },
  }

  useEffect(() => {
    if (!editingMemoryId) return

    setOpenSections((current) => (current.includes("memory") ? current : [...current, "memory"]))
  }, [editingMemoryId])

  function ensureSectionOpen(sectionKey: ProfileJourneySectionKey) {
    setOpenSections((current) =>
      current.includes(sectionKey) ? current : [...current, sectionKey],
    )
  }

  function toggleSection(sectionKey: ProfileJourneySectionKey) {
    setOpenSections((current) => {
      if (current.includes(sectionKey)) {
        return current.filter((key) => key !== sectionKey)
      }

      return [...current, sectionKey]
    })
  }

  function goToSectionStep(_sectionKey: ProfileJourneySectionKey, href: string) {
    router.push(href)
  }

  function startQuizEditing(fieldKey?: string) {
    setQuizNotice(null)
    if (fieldKey) {
      setPendingQuizFocusKey(fieldKey)
    }
    setQuizEditing(true)
  }

  function openTarget(
    sectionKey: ProfileJourneySectionKey,
    target: ProfileEditTarget | null,
    fieldKey?: string,
  ) {
    if (!target) return

    if (target.kind === "quiz") {
      startQuizEditing(fieldKey)
      return
    }

    if (target.kind === "profile-edit-goals") {
      goToSectionStep("goals", "/profile/edit/goals")
      return
    }

    goToSectionStep(sectionKey, buildOnboardingHref(target.step, { singleStep: true }))
  }

  function resetQuizEditing() {
    setQuizDraft(createQuizDraft(hairProfile))
    setQuizEditing(false)
    setPendingQuizFocusKey(null)
  }

  async function handleSaveQuiz() {
    if (!userId) return

    setQuizSaving(true)
    setQuizNotice(null)

    const quizPayload: Pick<
      HairProfile,
      | "hair_texture"
      | "thickness"
      | "density"
      | "hair_length"
      | "cuticle_condition"
      | "protein_moisture_balance"
      | "concerns"
      | "scalp_type"
      | "scalp_condition"
      | "chemical_treatment"
    > & { updated_at: string } = {
      hair_texture: (quizDraft.hair_texture || null) as HairProfile["hair_texture"],
      thickness: (quizDraft.thickness || null) as HairProfile["thickness"],
      density: (quizDraft.density || null) as HairProfile["density"],
      hair_length: (quizDraft.hair_length || null) as HairProfile["hair_length"],
      cuticle_condition: (quizDraft.cuticle_condition || null) as HairProfile["cuticle_condition"],
      protein_moisture_balance: (quizDraft.protein_moisture_balance ||
        null) as HairProfile["protein_moisture_balance"],
      concerns: quizDraft.concerns,
      scalp_type: (quizDraft.scalp_type || null) as HairProfile["scalp_type"],
      scalp_condition: (quizDraft.scalp_condition || null) as HairProfile["scalp_condition"],
      chemical_treatment: quizDraft.chemical_treatment,
      updated_at: new Date().toISOString(),
    }

    try {
      const { error } = await supabase.from("hair_profiles").upsert(
        {
          user_id: userId,
          ...quizPayload,
        },
        { onConflict: "user_id" },
      )

      if (error) throw error

      const nextProfile = createLocalHairProfile(hairProfile, userId, quizPayload)
      setHairProfile(nextProfile)
      setQuizDraft(createQuizDraft(nextProfile))
      setQuizEditing(false)
      setQuizNotice({
        variant: "success",
        title: "Haar-Check gespeichert",
        description:
          "Deine Antworten sind direkt aktualisiert und fließen ab jetzt in dein Profil ein.",
      })
      toast({
        title: "Haar-Check gespeichert",
        description: "Dein Profil wurde aktualisiert.",
      })
    } catch (error) {
      console.error("Error saving quiz data:", error)
      setQuizNotice({
        variant: "error",
        title: "Speichern fehlgeschlagen",
        description: "Bitte versuche es noch einmal. Deine bisherigen Angaben bleiben erhalten.",
      })
      toast({ title: fehler("Speichern"), variant: "destructive" })
    } finally {
      setQuizSaving(false)
    }
  }

  async function handleMemoryToggle(checked: boolean) {
    ensureSectionOpen("memory")
    setMemoryEnabled(checked)
    setMemorySaving(true)

    try {
      const response = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_enabled: checked }),
      })

      if (!response.ok) throw new Error("Memory setting failed")
      toast({ title: checked ? "Erinnerungen aktiviert" : "Erinnerungen pausiert" })
    } catch (error) {
      console.error("Error saving memory setting:", error)
      setMemoryEnabled(!checked)
      toast({ title: fehler("Speichern"), variant: "destructive" })
    } finally {
      setMemorySaving(false)
    }
  }

  function startEditingMemory(entry: UserMemoryEntry) {
    ensureSectionOpen("memory")
    setEditingMemoryId(entry.id)
    setMemoryDraft(entry.content)
  }

  async function handleSaveMemory(memoryId: string) {
    const content = memoryDraft.trim()
    if (!content) return

    setMemorySaving(true)

    try {
      const response = await fetch(`/api/memory/${memoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) throw new Error("Memory update failed")

      const data = (await response.json()) as { memory: UserMemoryEntry }
      setMemoryEntries((entries) =>
        entries.map((entry) => (entry.id === memoryId ? data.memory : entry)),
      )
      setEditingMemoryId(null)
      setMemoryDraft("")
      toast({ title: "Erinnerung gespeichert" })
    } catch (error) {
      console.error("Error saving memory:", error)
      toast({ title: fehler("Speichern"), variant: "destructive" })
    } finally {
      setMemorySaving(false)
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    setMemorySaving(true)

    try {
      const response = await fetch(`/api/memory/${memoryId}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Memory delete failed")

      setMemoryEntries((entries) => entries.filter((entry) => entry.id !== memoryId))
      if (editingMemoryId === memoryId) {
        setEditingMemoryId(null)
        setMemoryDraft("")
      }

      toast({ title: "Erinnerung gelöscht" })
    } catch (error) {
      console.error("Error deleting memory:", error)
      toast({ title: fehler("Löschen"), variant: "destructive" })
    } finally {
      setMemorySaving(false)
    }
  }

  const isMemoryOpen = openSections.includes("memory")

  if (authLoading) {
    return (
      <>
        <Header />
        <div className="profile-page">
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Header />
      <div className="profile-page">
        <main className="mx-auto max-w-5xl px-4 py-8">
          <div className="mb-10">
            <p className="type-overline text-primary">Profilübersicht</p>
            <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-medium leading-[0.96] tracking-tight text-[var(--text-heading)] sm:text-5xl">
              Mein Profil
            </h1>
          </div>

          <div className="space-y-6">
            <Card
              id="profile-section-quiz"
              className="scroll-mt-24 overflow-hidden border-primary/20 transition-colors"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.quiz.title}
                  description="Deine Antworten aus dem Haar-Check. Du kannst sie hier direkt pflegen, ohne den Flow noch einmal neu zu starten."
                  status={quizStatus}
                  isOpen
                  controls={
                    <>
                      {!quizEditing ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="w-auto"
                          onClick={() => startQuizEditing()}
                        >
                          Haar-Check bearbeiten
                        </Button>
                      ) : null}
                    </>
                  }
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {quizNotice ? (
                  <div
                    className={cn(
                      "rounded-xl border px-4 py-3",
                      quizNotice.variant === "success"
                        ? "border-primary/20 bg-primary/[0.05]"
                        : "border-destructive/20 bg-destructive/5",
                    )}
                  >
                    <p className="text-sm font-semibold text-[var(--text-heading)]">
                      {quizNotice.title}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{quizNotice.description}</p>
                  </div>
                ) : null}

                {profileLoading ? (
                  <SectionGridSkeleton count={6} className="md:grid-cols-2 xl:grid-cols-3" />
                ) : quizEditing ? (
                  <div className="rounded-2xl border border-primary/15 bg-muted/35 p-5">
                    <div className="mb-5">
                      <p className="text-sm font-semibold text-[var(--text-heading)]">
                        Haar-Check direkt im Profil aktualisieren
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        So musst du nicht noch einmal durch Login- oder Marketing-Schritte. Passe
                        nur die Antworten an, die sich ändern sollen.
                      </p>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-2">
                      <div
                        ref={(node) => {
                          quizFieldRefs.current.hair_texture = node
                        }}
                      >
                        <QuizEditorField
                          title="Haarstruktur"
                          text="Welche Haarstruktur die meisten deiner Haare haben."
                        >
                          <SegmentedControl
                            options={HAIR_TEXTURE_OPTIONS}
                            value={quizDraft.hair_texture}
                            onChange={(value) =>
                              setQuizDraft((current) => ({ ...current, hair_texture: value }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.thickness = node
                        }}
                      >
                        <QuizEditorField
                          title="Haardicke"
                          text="Wie sich ein einzelnes Haar bei dir meistens im Vergleich zu einem Nähfaden anfühlt."
                        >
                          <SegmentedControl
                            options={HAIR_THICKNESS_OPTIONS}
                            value={quizDraft.thickness}
                            onChange={(value) =>
                              setQuizDraft((current) => ({ ...current, thickness: value }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.density = node
                        }}
                      >
                        <QuizEditorField
                          title="Haardichte"
                          text="Wie viele Haare du insgesamt hast - nicht wie dick ein einzelnes Haar ist."
                        >
                          <SegmentedControl
                            options={HAIR_DENSITY_OPTIONS}
                            value={quizDraft.density}
                            onChange={(value) =>
                              setQuizDraft((current) => ({ ...current, density: value }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.hair_length = node
                        }}
                      >
                        <QuizEditorField
                          title="Haarlänge"
                          text="Wie lang deine Haare aktuell sind; bei Locken zählt die sanft gestreckte Länge."
                        >
                          <SegmentedControl
                            options={HAIR_LENGTH_OPTIONS}
                            value={quizDraft.hair_length}
                            onChange={(value) =>
                              setQuizDraft((current) => ({ ...current, hair_length: value }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.cuticle_condition = node
                        }}
                      >
                        <QuizEditorField
                          title="Oberfläche"
                          text="Wie sich dein Haar im Finger-Test anfühlt."
                        >
                          <SegmentedControl
                            options={QUIZ_SURFACE_OPTIONS}
                            value={quizDraft.cuticle_condition}
                            onChange={(value) =>
                              setQuizDraft((current) => ({
                                ...current,
                                cuticle_condition: value,
                              }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.protein_moisture_balance = node
                        }}
                      >
                        <QuizEditorField
                          title="Elastizität"
                          text="Wie dein Haar im Zug-Test reagiert."
                        >
                          <SegmentedControl
                            options={QUIZ_ELASTICITY_OPTIONS}
                            value={quizDraft.protein_moisture_balance}
                            onChange={(value) =>
                              setQuizDraft((current) => ({
                                ...current,
                                protein_moisture_balance: value,
                              }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.chemical_treatment = node
                        }}
                        className="xl:col-span-2"
                      >
                        <QuizEditorField
                          title="Chemische Behandlungen"
                          text="Was in deinen Längen noch vorhanden ist; Pflege, Bondbuilder und normales Hitzestyling zählen hier nicht."
                        >
                          <div className="flex flex-wrap gap-2">
                            {QUIZ_CHEMICAL_TREATMENT_OPTIONS.map((option) => {
                              const active = quizDraft.chemical_treatment.includes(option.value)

                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() =>
                                    setQuizDraft((current) => ({
                                      ...current,
                                      chemical_treatment: toggleChemicalTreatment(
                                        current.chemical_treatment,
                                        option.value,
                                      ),
                                    }))
                                  }
                                  className={cn(
                                    "min-h-[40px] rounded-full border px-3 py-2 text-sm transition-colors",
                                    active
                                      ? "border-primary bg-primary/10 text-primary"
                                      : "border-border hover:bg-muted",
                                  )}
                                >
                                  {option.label}
                                </button>
                              )
                            })}
                          </div>
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.scalp_type = node
                        }}
                      >
                        <QuizEditorField
                          title="Kopfhauttyp"
                          text="Wie sich deine Kopfhaut zwischen den Haarwäschen verhält."
                        >
                          <SegmentedControl
                            options={QUIZ_SCALP_TYPE_OPTIONS}
                            value={quizDraft.scalp_type}
                            onChange={(value) =>
                              setQuizDraft((current) => ({ ...current, scalp_type: value }))
                            }
                          />
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.scalp_condition = node
                        }}
                      >
                        <QuizEditorField
                          title="Kopfhaut-Beschwerden"
                          text="Wähle eine aktive Beschwerde oder markiere, dass aktuell nichts davon zutrifft."
                        >
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setQuizDraft((current) => ({ ...current, scalp_condition: "" }))
                              }
                              className={cn(
                                "min-h-[40px] rounded-full border px-3 py-2 text-sm transition-colors",
                                quizDraft.scalp_condition === ""
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border hover:bg-muted",
                              )}
                            >
                              Keine Beschwerden
                            </button>
                            {QUIZ_SCALP_CONDITION_OPTIONS.map((option) => {
                              const active = quizDraft.scalp_condition === option.value

                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() =>
                                    setQuizDraft((current) => ({
                                      ...current,
                                      scalp_condition:
                                        current.scalp_condition === option.value
                                          ? ""
                                          : option.value,
                                    }))
                                  }
                                  className={cn(
                                    "min-h-[40px] rounded-full border px-3 py-2 text-sm transition-colors",
                                    active
                                      ? "border-primary bg-primary/10 text-primary"
                                      : "border-border hover:bg-muted",
                                  )}
                                >
                                  {option.label}
                                </button>
                              )
                            })}
                          </div>
                        </QuizEditorField>
                      </div>

                      <div
                        ref={(node) => {
                          quizFieldRefs.current.concerns = node
                        }}
                        className="xl:col-span-2"
                      >
                        <QuizEditorField
                          title="Haar-Bedenken"
                          text="Bis zu drei aktuelle Themen für deine Längen und Spitzen."
                        >
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setQuizDraft((current) => ({ ...current, concerns: [] }))
                              }
                              className={cn(
                                "min-h-[40px] rounded-full border px-3 py-2 text-sm transition-colors",
                                quizDraft.concerns.length === 0
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border hover:bg-muted",
                              )}
                            >
                              Nichts davon
                            </button>
                            {QUIZ_CONCERN_OPTIONS.map((option) => {
                              const active = quizDraft.concerns.includes(option.value)
                              const disabled = !active && quizDraft.concerns.length >= 3

                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  disabled={disabled}
                                  onClick={() =>
                                    setQuizDraft((current) => ({
                                      ...current,
                                      concerns: toggleConcern(current.concerns, option.value),
                                    }))
                                  }
                                  className={cn(
                                    "min-h-[40px] rounded-full border px-3 py-2 text-sm transition-colors disabled:opacity-40",
                                    active
                                      ? "border-primary bg-primary/10 text-primary"
                                      : "border-border hover:bg-muted",
                                  )}
                                >
                                  {option.label}
                                </button>
                              )
                            })}
                          </div>
                        </QuizEditorField>
                      </div>
                    </div>

                    <div className="mt-6 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="w-auto"
                        onClick={handleSaveQuiz}
                        disabled={quizSaving}
                      >
                        {quizSaving ? "Speichern..." : "Haar-Check speichern"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={resetQuizEditing}
                        disabled={quizSaving}
                      >
                        Abbrechen
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {hairProfile?.hair_length == null ? (
                      <InlinePromptCard
                        title="Haarlänge ergänzen"
                        text="Ergänze deine Haarlänge, damit Mengen und Anwendungshinweise genauer werden."
                        action={
                          <Button
                            type="button"
                            variant="outline"
                            className="w-auto"
                            onClick={() => startQuizEditing("hair_length")}
                          >
                            Haarlänge ergänzen
                          </Button>
                        }
                      />
                    ) : null}

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {quizFields.map((field) => {
                        const isMissing = field.value == null
                        return (
                          <ProfileFieldCard
                            key={field.key}
                            field={field}
                            onClick={() => openTarget("quiz", field.editTarget, field.key)}
                            tone={isMissing ? "attention" : "default"}
                            className={isMissing ? "md:col-span-2 xl:col-span-3" : undefined}
                          >
                            {isMissing ? (
                              <ProfileFieldValue
                                value={null}
                                emptyLabel="Noch offen — tippen zum Ergänzen"
                              />
                            ) : undefined}
                          </ProfileFieldCard>
                        )
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card
              id="profile-section-products"
              className="scroll-mt-24 overflow-hidden border-primary/20 transition-colors"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.products.title}
                  description="Welche Produktkategorien du aktuell nutzt und welche Produktdetails im Onboarding festgehalten wurden."
                  status={productsStatus}
                  isOpen
                  controls={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() =>
                          goToSectionStep("products", buildOnboardingHref("products_basics"))
                        }
                      >
                        Produkte bearbeiten
                      </Button>
                    </>
                  }
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {productsLoading ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-border/80 bg-card/80 p-4">
                      <Skeleton className="h-4 w-36" />
                      <Skeleton className="mt-2 h-3 w-56" />
                      <div className="mt-4 flex flex-wrap gap-2">
                        {Array.from({ length: 4 }).map((_, index) => (
                          <Skeleton key={index} className="h-8 w-24 rounded-full" />
                        ))}
                      </div>
                    </div>
                    <SectionGridSkeleton count={3} className="md:grid-cols-3" />
                  </div>
                ) : productRows.length > 0 ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-border/80 bg-card/80 p-4 shadow-sm">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[var(--text-heading)]">
                          Ausgewählte Kategorien
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Damit ist auf einen Blick sichtbar, welche Produkttypen du überhaupt im
                          Alltag nutzt.
                        </p>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {selectedProductCategories.map((category) => (
                          <Badge
                            key={category}
                            variant="outline"
                            className="border-primary/20 bg-primary/[0.04] px-3 py-1 text-xs text-foreground"
                          >
                            {category}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="hidden overflow-hidden rounded-xl border border-border/80 md:block">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-4 bg-muted/35 px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        <span>Kategorie</span>
                        <span>Produkt</span>
                        <span>Häufigkeit</span>
                      </div>

                      {productRows.map((row) => (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() =>
                            goToSectionStep(
                              "products",
                              buildOnboardingHref("product_drilldown", {
                                category: row.category,
                                singleStep: true,
                              }),
                            )
                          }
                          className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-4 border-t border-border/70 px-4 py-4 text-left transition-colors hover:bg-primary/[0.04]"
                        >
                          <div>
                            <p className="text-sm font-semibold text-[var(--text-heading)]">
                              {row.categoryLabel}
                            </p>
                            {row.needsUserDetails ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Details fehlen noch
                              </p>
                            ) : null}
                          </div>
                          <div
                            className={cn(
                              "text-sm",
                              row.productName ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {row.productName ?? "Noch offen"}
                            {row.reviewStatusLabel ? (
                              <div className="mt-2">
                                <ProductReviewStatusBadge label={row.reviewStatusLabel} />
                              </div>
                            ) : null}
                          </div>
                          <p
                            className={cn(
                              "text-sm",
                              row.frequencyLabel ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {row.frequencyLabel ?? "Noch offen"}
                          </p>
                        </button>
                      ))}
                    </div>

                    <div className="grid gap-3 md:hidden">
                      {productRows.map((row) => (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() =>
                            goToSectionStep(
                              "products",
                              buildOnboardingHref("product_drilldown", {
                                category: row.category,
                                singleStep: true,
                              }),
                            )
                          }
                          className="rounded-xl border border-border/80 bg-card/80 p-4 text-left shadow-sm transition-colors hover:bg-primary/[0.04]"
                        >
                          <p className="text-sm font-semibold text-[var(--text-heading)]">
                            {row.categoryLabel}
                          </p>
                          <div className="mt-3 space-y-2 text-sm">
                            <div>
                              <span className="text-muted-foreground">Produkt:</span>{" "}
                              <span
                                className={
                                  row.productName ? "text-foreground" : "text-muted-foreground"
                                }
                              >
                                {row.productName ?? "Noch offen"}
                              </span>
                              {row.reviewStatusLabel ? (
                                <div className="mt-2">
                                  <ProductReviewStatusBadge label={row.reviewStatusLabel} />
                                </div>
                              ) : null}
                            </div>
                            <p>
                              <span className="text-muted-foreground">Häufigkeit:</span>{" "}
                              <span
                                className={
                                  row.frequencyLabel ? "text-foreground" : "text-muted-foreground"
                                }
                              >
                                {row.frequencyLabel ?? "Noch offen"}
                              </span>
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <InlinePromptCard
                    title={
                      profile?.onboarding_completed
                        ? "Noch keine Produkte ausgewählt"
                        : "Noch keine Produktangaben vorhanden"
                    }
                    text={
                      profile?.onboarding_completed
                        ? "Im aktuellen Onboarding-Stand wurden noch keine Produktkategorien gespeichert."
                        : "Sobald du den Produktteil im Onboarding durchläufst, erscheint hier eine klare Übersicht nach Kategorie, Produkt und Häufigkeit."
                    }
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() =>
                          goToSectionStep("products", buildOnboardingHref("products_basics"))
                        }
                      >
                        Produktteil öffnen
                      </Button>
                    }
                  />
                )}

                {!productsLoading && incompleteProductRows.length > 0 ? (
                  <InlinePromptCard
                    title={getOpenItemsTitle(
                      incompleteProductRows.length,
                      "Produktdetail",
                      "Produktdetails",
                    )}
                    text="Öffne den Produktteil, um die fehlenden Angaben zu ergänzen."
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() =>
                          goToSectionStep(
                            "products",
                            buildOnboardingHref("product_drilldown", {
                              category: incompleteProductRows[0]?.category ?? null,
                            }),
                          )
                        }
                      >
                        Details ergänzen
                      </Button>
                    }
                  />
                ) : null}
              </CardContent>
            </Card>

            <Card
              id="profile-section-styling"
              className="scroll-mt-24 overflow-hidden border-primary/20 transition-colors"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.styling.title}
                  description={SECTION_META_BY_KEY.styling.description}
                  status={stylingStatus}
                  isOpen
                  controls={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() =>
                          goToSectionStep("styling", buildOnboardingHref("heat_tools"))
                        }
                      >
                        Styling bearbeiten
                      </Button>
                    </>
                  }
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {profileLoading ? (
                  <SectionGridSkeleton count={3} className="md:grid-cols-2 xl:grid-cols-3" />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {stylingFields.map((field) => {
                      const isMissing = field.value == null
                      return (
                        <ProfileFieldCard
                          key={field.key}
                          field={field}
                          onClick={() => openTarget("styling", field.editTarget)}
                          tone={isMissing ? "attention" : "default"}
                          className={isMissing ? "md:col-span-2 xl:col-span-3" : undefined}
                        >
                          {isMissing ? (
                            <ProfileFieldValue
                              value={null}
                              emptyLabel="Noch offen — tippen zum Ergänzen"
                            />
                          ) : undefined}
                        </ProfileFieldCard>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card
              id="profile-section-routine"
              className="scroll-mt-24 overflow-hidden border-primary/20 transition-colors"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.routine.title}
                  description={SECTION_META_BY_KEY.routine.description}
                  status={routineStatus}
                  isOpen
                  controls={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() =>
                          goToSectionStep("routine", buildOnboardingHref("towel_material"))
                        }
                      >
                        Alltag bearbeiten
                      </Button>
                    </>
                  }
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {profileLoading ? (
                  <SectionGridSkeleton count={5} className="md:grid-cols-2 xl:grid-cols-3" />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {routineFields.map((field) => {
                      const isMissing = field.value == null
                      return (
                        <ProfileFieldCard
                          key={field.key}
                          field={field}
                          onClick={() => openTarget("routine", field.editTarget)}
                          tone={isMissing ? "attention" : "default"}
                          className={isMissing ? "md:col-span-2 xl:col-span-3" : undefined}
                        >
                          {isMissing ? (
                            <ProfileFieldValue
                              value={null}
                              emptyLabel="Noch offen — tippen zum Ergänzen"
                            />
                          ) : undefined}
                        </ProfileFieldCard>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card
              id="profile-section-goals"
              className="scroll-mt-24 overflow-hidden border-primary/20 transition-colors"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.goals.title}
                  description={SECTION_META_BY_KEY.goals.description}
                  status={goalsStatus}
                  isOpen
                  controls={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-auto"
                        onClick={() => goToSectionStep("goals", "/profile/edit/goals")}
                      >
                        Ziele bearbeiten
                      </Button>
                    </>
                  }
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {profileLoading ? (
                  <div className="rounded-xl border border-border/70 bg-card/70 p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-2 h-3 w-56" />
                    <div className="mt-5 flex flex-wrap gap-2">
                      {Array.from({ length: 5 }).map((_, index) => (
                        <Skeleton key={index} className="h-8 w-28 rounded-full" />
                      ))}
                    </div>
                  </div>
                ) : goalsField ? (
                  <button
                    type="button"
                    onClick={() => openTarget("goals", goalsField.editTarget)}
                    className="flex w-full flex-wrap gap-2 rounded-[22px] border border-primary/10 bg-[hsl(var(--background))]/70 p-5 text-left transition-colors hover:border-primary/30 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-label={`${goalsField.label} bearbeiten`}
                  >
                    {Array.isArray(goalsField.value) && goalsField.value.length > 0 ? (
                      goalsField.value.map((goal) => (
                        <Badge
                          key={goal}
                          variant="outline"
                          className="rounded-full border-primary/20 bg-background px-4 py-1.5 text-sm font-semibold text-[var(--text-heading)]"
                        >
                          {goal}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Noch keine Ziele gewählt
                      </span>
                    )}
                  </button>
                ) : null}
              </CardContent>
            </Card>

            <div className="mt-12 border-t border-border/60 pt-8">
              <h2 className="font-[family-name:var(--font-display)] text-3xl font-medium leading-none text-[var(--text-heading)]">
                Einstellungen
              </h2>
            </div>

            <Card
              id="profile-section-memory"
              className="mt-4 overflow-hidden border-border/60 bg-card/60"
            >
              <CardHeader className="pb-4">
                <SectionHeader
                  title={SECTION_META_BY_KEY.memory.title}
                  description={SECTION_META_BY_KEY.memory.description}
                  status={memoryStatus}
                  isOpen={isMemoryOpen}
                  preview={memorySectionSummary.preview}
                  controls={
                    <>
                      <Switch
                        checked={memoryEnabled}
                        disabled={memoryLoading || memorySaving}
                        onCheckedChange={handleMemoryToggle}
                        aria-label="Erinnerungen aktivieren"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-auto px-3 text-primary hover:bg-primary/[0.06]"
                        onClick={() => toggleSection("memory")}
                        aria-expanded={isMemoryOpen}
                        aria-controls="profile-section-panel-memory"
                        aria-label={
                          isMemoryOpen ? "Erinnerungen zuklappen" : "Erinnerungen aufklappen"
                        }
                      >
                        <span>{isMemoryOpen ? "Weniger" : "Mehr"}</span>
                        <ChevronDown
                          className={cn("transition-transform", isMemoryOpen ? "rotate-180" : "")}
                        />
                      </Button>
                    </>
                  }
                  size="sm"
                />
              </CardHeader>
              {isMemoryOpen ? (
                <CardContent id="profile-section-panel-memory">
                  {memoryLoading ? (
                    <p className="text-sm text-muted-foreground">Erinnerungen werden geladen...</p>
                  ) : memoryEntries.length === 0 ? (
                    <InlinePromptCard
                      title="Noch keine gespeicherten Erinnerungen"
                      text="Wenn du im Chat konkrete Haarpflege-Infos gibst, können sie hier als langfristiger Kontext auftauchen."
                    />
                  ) : (
                    <div className="divide-y">
                      {memoryEntries.map((entry) => (
                        <div key={entry.id} className="py-4 first:pt-0 last:pb-0">
                          {editingMemoryId === entry.id ? (
                            <div className="space-y-3">
                              <Textarea
                                value={memoryDraft}
                                onChange={(event) => setMemoryDraft(event.target.value)}
                                rows={3}
                                maxLength={500}
                              />
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  className="w-auto"
                                  onClick={() => handleSaveMemory(entry.id)}
                                  disabled={memorySaving || !memoryDraft.trim()}
                                >
                                  Speichern
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="w-auto"
                                  onClick={() => {
                                    setEditingMemoryId(null)
                                    setMemoryDraft("")
                                  }}
                                >
                                  Abbrechen
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <p className="text-sm text-foreground">{entry.content}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Aktualisiert am{" "}
                                  {new Date(entry.updated_at).toLocaleDateString("de-DE")}
                                </p>
                              </div>
                              <div className="flex shrink-0 gap-2">
                                <button
                                  type="button"
                                  onClick={() => startEditingMemory(entry)}
                                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  Bearbeiten
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteMemory(entry.id)}
                                  disabled={memorySaving}
                                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                                >
                                  Löschen
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              ) : null}
            </Card>

            <section
              id="mitgliedschaft"
              className="mt-4 scroll-mt-24 rounded-2xl border border-border/60 bg-card/60 p-6"
            >
              <h2 className="mb-3 font-[family-name:var(--font-display)] text-lg font-medium text-[var(--text-heading)]">
                Mitgliedschaft
              </h2>

              {membershipReactivated ? (
                <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
                  Deine Mitgliedschaft wurde reaktiviert. Schön, dass du wieder da bist.
                </div>
              ) : null}

              {planChangeNotice ? (
                <div className="mb-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
                  {planChangeNotice}
                </div>
              ) : null}

              {membershipLoading ? (
                <div className="space-y-2" aria-label="Mitgliedschaft wird geladen">
                  <Skeleton className="h-5 w-36" />
                  <Skeleton className="h-10 w-52" />
                </div>
              ) : null}

              {!membershipLoading && membershipState && membershipState.kind !== "uncertain" ? (
                <>
                  <p className="mb-1 text-sm text-muted-foreground">
                    Status:{" "}
                    <strong className="text-foreground">
                      {membershipStatusLabel(membershipState)}
                    </strong>
                  </p>
                  {"provider" in membershipState ? (
                    <p className="mb-1 text-sm text-muted-foreground">
                      Anbieter:{" "}
                      <strong className="text-foreground">
                        {membershipState.provider === "paypal" ? "PayPal" : "Stripe"}
                      </strong>
                    </p>
                  ) : null}
                  {"currentInterval" in membershipState && membershipState.currentInterval ? (
                    <p className="mb-1 text-sm text-muted-foreground">
                      Aktueller Plan:{" "}
                      <strong className="text-foreground">
                        {intervalLabel(membershipState.currentInterval)}
                      </strong>
                    </p>
                  ) : null}
                  {membershipState.renewalAt ? (
                    <p className="mb-4 text-sm text-muted-foreground">
                      Nächste Abrechnung / Laufzeitende:{" "}
                      <strong className="text-foreground">
                        {formatBillingDate(membershipState.renewalAt)}
                      </strong>
                    </p>
                  ) : (
                    <p className="mb-4 text-sm text-muted-foreground">
                      Dein Chaarlie-Zugang ist aktiv.
                    </p>
                  )}
                  {"provider" in membershipState ? (
                    <ManageSubscriptionButton
                      provider={membershipState.provider}
                      currentPeriodEnd={membershipState.renewalAt}
                      cancelAtPeriodEnd={membershipState.cancelAtPeriodEnd}
                    />
                  ) : null}
                  {membershipState.kind === "legacy_unmanageable" && profile?.stripe_customer_id ? (
                    <ManageSubscriptionButton
                      provider="stripe"
                      currentPeriodEnd={membershipState.renewalAt}
                    />
                  ) : null}
                  <ProfilePlanSwitcher
                    state={membershipState}
                    onRefresh={() => setMembershipReloadKey((current) => current + 1)}
                  />
                </>
              ) : null}

              {!membershipLoading && (membershipError || membershipState?.kind === "uncertain") ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Der Mitgliedschaftsstatus konnte gerade nicht sicher geladen werden. Änderungen
                    sind deshalb vorerst gesperrt.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4 w-auto"
                    onClick={() => setMembershipReloadKey((current) => current + 1)}
                  >
                    Status erneut prüfen
                  </Button>
                </>
              ) : null}
            </section>

            <Card className="mt-4 border-border/60 bg-card/60">
              <CardHeader className="pb-3">
                <h2 className="font-[family-name:var(--font-display)] text-lg font-medium text-[var(--text-heading)]">
                  Account
                </h2>
                <CardDescription className="mt-1 text-sm">
                  Dein Zugang bleibt bewusst sekundär, damit das Profil weiterhin mit deiner
                  Haarreise startet.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={profile?.avatar_url ?? undefined} alt="Avatar" />
                    <AvatarFallback>
                      {(profile?.full_name || profile?.email || "HC").slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-heading)]">
                      {profile?.full_name || "—"}
                    </p>
                    <p className="text-sm text-muted-foreground">{profile?.email}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </>
  )
}
