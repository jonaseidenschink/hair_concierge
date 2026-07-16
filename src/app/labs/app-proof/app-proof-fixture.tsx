"use client"

import { Menu, MessageCircle, SendHorizontal, Sparkles } from "lucide-react"

import { ProductDetailDrawer } from "@/components/chat/product-detail-drawer"
import { RoutineCard } from "@/components/routine/routine-card"
import type { RoutineUiCard } from "@/lib/routines/types"
import type { HairProfile, Product } from "@/lib/types"

export type AppProofState = "routine" | "product" | "chat"

const SHAMPOO_IMAGE =
  "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-04/ead1333b-6839-464d-b272-673d39bb95a4/02-ead1333b-6839-464d-b272-673d39bb95a4-balea-balea-aqua-hyaluron-f41a5b48efe1.webp"
const CONDITIONER_IMAGE =
  "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-01/2a159694-6799-4be7-a0aa-572757c94801/31-2a159694-6799-4be7-a0aa-572757c94801-langhaarmadchen-langhaarmadchen-lovely-long-d30fd7fd3ec3.webp"
const LEAVE_IN_IMAGE =
  "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-02/0b21f996-bb42-4b10-89bd-4881c4346d53/22-0b21f996-bb42-4b10-89bd-4881c4346d53-isana-isana-feuchtigkeits-leave-in-hyaluron-ba1624f6c1eb.webp"

const CONDITIONER_PRODUCT = {
  id: "2a159694-6799-4be7-a0aa-572757c94801",
  brand: "Langhaarmädchen",
  name: "Langhaarmädchen Lovely Long Conditioner",
  category: "Conditioner (Drogerie)",
  image_url: CONDITIONER_IMAGE,
  affiliate_link: "https://www.dm.de/langhaarmaedchen-conditioner-lovely-long-p4058172702136.html",
  price_eur: 4.95,
  currency: "EUR",
  is_active: true,
  lifecycle_status: "active",
  purchase_link_status: "available",
  suitable_thicknesses: ["normal"],
  suitable_concerns: [],
  short_description: "Ausgewogene Pflege mit mittlerem Gewicht für trockene Längen.",
  recommendation_meta: {
    category: "conditioner",
    usage_hint:
      "Nach dem Shampoo in Längen und Spitzen verteilen, kurz einwirken lassen und gründlich ausspülen",
  },
} as unknown as Product

const HAIR_PROFILE = {
  thickness: "normal",
  goals: ["moisture", "less_frizz"],
  concerns: ["dryness", "frizz"],
} as unknown as HairProfile

function productCard({
  id,
  category,
  categoryLabel,
  name,
  imageUrl,
}: {
  id: string
  category: string
  categoryLabel: string
  name: string
  imageUrl: string
}): RoutineUiCard {
  return {
    id,
    kind: "verified_matches",
    tone: "green",
    category,
    categoryLabel,
    productName: name,
    currentFrequency: "weekly_3_4x",
    frequencyTarget: {
      minFrequency: "weekly_2x",
      maxFrequency: "weekly_3_4x",
      preferredFrequency: "weekly_3_4x",
      delta: "in_range",
    },
    careBalanceRow: null,
    usageRow: null,
    product: {
      id,
      name,
      brand: name.split(" ")[0] ?? null,
      category,
      affiliate_link: null,
      image_url: imageUrl,
      price_eur: null,
      currency: "EUR",
      is_active: true,
    },
    pendingSubmission: null,
    hasProductDrawer: true,
    isLegacyTextOnly: false,
    isTopProposal: false,
  }
}

const ROUTINE_CARDS: RoutineUiCard[] = [
  productCard({
    id: "ead1333b-6839-464d-b272-673d39bb95a4",
    category: "shampoo",
    categoryLabel: "Shampoo",
    name: "Balea Aqua Hyaluron",
    imageUrl: SHAMPOO_IMAGE,
  }),
  productCard({
    id: CONDITIONER_PRODUCT.id,
    category: "conditioner",
    categoryLabel: "Conditioner",
    name: CONDITIONER_PRODUCT.name,
    imageUrl: CONDITIONER_IMAGE,
  }),
  productCard({
    id: "0b21f996-bb42-4b10-89bd-4881c4346d53",
    category: "leave_in",
    categoryLabel: "Leave-in",
    name: "Isana Feuchtigkeits Leave-In",
    imageUrl: LEAVE_IN_IMAGE,
  }),
]

function AppHeader({ title }: { title: string }) {
  return (
    <header className="flex h-[68px] items-center justify-between border-b border-border bg-white px-5">
      <span className="font-header text-[27px] font-medium text-[var(--brand-plum-darkest)]">
        <span className="mr-2 text-[var(--brand-plum)]">Ⅲ</span>
        chaarlie
      </span>
      <span className="grid size-8 place-items-center rounded-full border border-border text-[13px] font-semibold text-[var(--brand-plum)]">
        C
      </span>
      <span className="sr-only">{title}</span>
    </header>
  )
}

function RoutineProof() {
  return (
    <div className="min-h-[844px] bg-[#FBFAF8]">
      <AppHeader title="Routine" />
      <main className="px-5 pb-8 pt-6">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--brand-plum)]">
          Routine
        </p>
        <h1 className="mt-2 font-header text-[31px] font-medium leading-[1.1] text-[var(--brand-plum-darkest)]">
          Deine aktuelle Haarpflege
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          Deine Produkte in der richtigen Reihenfolge.
        </p>
        <div className="mt-6 space-y-3">
          {ROUTINE_CARDS.map((card) => (
            <RoutineCard
              card={card}
              key={card.id}
              onDismissSuggestion={() => undefined}
              onTap={() => undefined}
            />
          ))}
        </div>
        <div className="mt-5 rounded-[18px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] p-4">
          <p className="text-[12px] font-semibold text-[var(--brand-plum-darkest)]">
            Deine Reihenfolge
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            1. Shampoo · 2. Conditioner · 3. Leave-in
          </p>
        </div>
      </main>
    </div>
  )
}

function ProductProof() {
  return (
    <div className="min-h-[844px] bg-[#FBFAF8]">
      <AppHeader title="Produktdetail" />
      <div className="px-5 pt-7">
        <p className="text-[13px] text-muted-foreground">Deine Routine</p>
      </div>
      <style>{`.bottom-sheet-panel { max-height: calc(100vh - 68px) !important; }`}</style>
      <ProductDetailDrawer
        hairProfile={HAIR_PROFILE}
        onOpenChange={() => undefined}
        open
        product={CONDITIONER_PRODUCT}
      />
    </div>
  )
}

const CHAT_PROMPTS = [
  "Welche Routine passt am besten zu meinem Haarprofil?",
  "Was hilft bei Frizz in meinen Längen?",
  "Wie verwende ich meinen Conditioner richtig?",
] as const

function ChatProof() {
  return (
    <div className="flex min-h-[844px] flex-col bg-[#FBFAF8]">
      <AppHeader title="Chat" />
      <div className="flex h-[52px] items-center gap-3 border-b border-border bg-white px-4">
        <Menu aria-hidden="true" className="size-5 text-muted-foreground" />
        <span className="text-[14px] font-medium">Neuer Chat</span>
      </div>
      <main className="flex flex-1 flex-col px-5 pb-5 pt-8">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-[var(--brand-plum)] text-white">
          <Sparkles aria-hidden="true" className="size-7" />
        </div>
        <h1 className="mt-5 text-center font-header text-[28px] font-medium text-[var(--brand-plum-darkest)]">
          Guten Tag, Charlene
        </h1>
        <p className="mx-auto mt-2 max-w-[34ch] text-center text-[13px] leading-relaxed text-muted-foreground">
          Frag mich nach deiner Routine, passenden Produkten oder dem nächsten sinnvollen Schritt
          für dein Haarprofil.
        </p>
        <p className="mt-7 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Starterfragen
        </p>
        <div className="mt-2 space-y-2">
          {CHAT_PROMPTS.map((prompt) => (
            <div
              className="flex items-start gap-3 rounded-[14px] border border-border bg-white px-4 py-3 text-[13px] leading-snug text-[var(--brand-plum-darkest)]"
              key={prompt}
            >
              <MessageCircle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-[var(--brand-plum)]"
              />
              {prompt}
            </div>
          ))}
        </div>
        <div className="mt-auto flex min-h-[50px] items-center gap-3 rounded-[14px] border border-border bg-white px-4 text-[13px] text-muted-foreground">
          <span className="flex-1">Stelle eine Frage zu deinen Haaren…</span>
          <span className="grid size-9 place-items-center rounded-[11px] bg-[var(--brand-coral-light)] text-[var(--brand-coral)]">
            <SendHorizontal aria-hidden="true" className="size-4" />
          </span>
        </div>
      </main>
    </div>
  )
}

export function AppProofFixture({ state }: { state: AppProofState }) {
  return (
    <div
      className="w-[390px] overflow-hidden bg-[#FBFAF8] text-foreground"
      data-state={state}
      data-testid="app-proof-fixture"
    >
      {state === "routine" ? (
        <RoutineProof />
      ) : state === "product" ? (
        <ProductProof />
      ) : (
        <ChatProof />
      )}
    </div>
  )
}
