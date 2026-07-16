"use client"

import Image from "next/image"
import Link from "next/link"
import {
  Check,
  CloudCheck,
  CircleAlert,
  Droplets,
  HeartHandshake,
  LoaderCircle,
  Moon,
  PencilLine,
  Sparkles,
  Wind,
  type LucideIcon,
} from "lucide-react"
import { useId } from "react"

import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet"
import { Checkbox } from "@/components/ui/checkbox"
import {
  orderTrackerShelfForActivity,
  TRACKER_ACTIVITY_PRESENTATION_DE,
  TRACKER_PREFILL_SOURCE_COPY_DE,
  TRACKER_PROFILE_DISCLAIMER_DE,
} from "@/lib/tracking/presentation"
import type { TrackerSaveState } from "@/lib/tracking/save-coordinator"
import {
  TRACKER_CATEGORY_LABELS_DE,
  TRACKER_DAY_TYPES,
  type TrackerDayType,
  type TrackerLogDay,
  type TrackerLogProduct,
} from "@/lib/tracking/types"
import { cn } from "@/lib/utils"

const ACTIVITY_ICONS: Record<TrackerDayType, LucideIcon> = {
  wash: Droplets,
  clarifying: Sparkles,
  treatment_only: HeartHandshake,
  styling_only: Wind,
  none: Moon,
  custom: PencilLine,
}

export interface ShelfItem {
  usageId: string
  category: string
  productName: string | null
  imageUrl: string | null
}

function productKey(product: TrackerLogProduct): string {
  return product.userProductUsageId ?? `${product.category}:${product.productName ?? ""}`
}

function ProductRow(props: {
  item: ShelfItem
  checked: boolean
  onToggle: (checked: boolean) => void
}) {
  const checkboxId = useId()
  return (
    <div
      className={cn(
        "tracker-product-row flex min-h-[62px] items-center gap-3 rounded-[14px] border p-2 pr-3",
        props.checked
          ? "border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)]"
          : "border-border bg-background hover:border-[var(--brand-plum-light)]",
      )}
    >
      <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <span className="flex h-12 w-[42px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[#F3EFE8] shadow-[inset_0_0_0_1px_rgba(31,26,20,0.04)]">
          {props.item.imageUrl ? (
            <Image
              src={props.item.imageUrl}
              alt=""
              width={32}
              height={46}
              unoptimized
              data-testid={`tracker-product-image-${props.item.usageId}`}
              className="tracker-product-image h-[94%] w-[72%] object-contain"
            />
          ) : (
            <span
              aria-hidden="true"
              className="tracker-product-image-fallback font-header text-xl text-[rgba(var(--brand-plum-rgb),0.42)]"
            >
              {(TRACKER_CATEGORY_LABELS_DE[props.item.category] ?? props.item.category).charAt(0)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium text-foreground">
            {TRACKER_CATEGORY_LABELS_DE[props.item.category] ?? props.item.category}
          </span>
          {props.item.productName ? (
            <span className="block truncate text-xs text-muted-foreground">
              {props.item.productName}
            </span>
          ) : null}
        </span>
      </label>
      <Checkbox
        id={checkboxId}
        checked={props.checked}
        onCheckedChange={props.onToggle}
        aria-label={`${TRACKER_CATEGORY_LABELS_DE[props.item.category] ?? props.item.category} ${props.item.productName ?? ""}`}
        className="h-5 w-5 border-[var(--brand-plum)] bg-white data-[state=checked]:bg-[var(--brand-plum)]"
      />
    </div>
  )
}

function SaveStatus(props: { state: TrackerSaveState; onRetry: () => void }) {
  const polite =
    props.state.status === "pending" || props.state.status === "saving"
      ? "Wird gespeichert …"
      : props.state.status === "saved"
        ? "Gespeichert"
        : ""
  const failed = props.state.status === "error"
  const saving = props.state.status === "pending" || props.state.status === "saving"

  return (
    <div className="min-h-5 min-w-0 text-xs">
      <p
        className="tracker-save-status flex items-center gap-1.5 text-[var(--brand-plum-dark)]"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite ? (
          saving ? (
            <LoaderCircle
              className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <CloudCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )
        ) : null}
        <span>{polite}</span>
      </p>
      <p
        className="tracker-save-status flex items-center gap-1.5 text-destructive"
        role="alert"
        aria-atomic="true"
      >
        {failed ? <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
        {failed ? <span>Konnte nicht gespeichert werden.</span> : null}
        {failed ? (
          <button type="button" className="ml-2 font-medium underline" onClick={props.onRetry}>
            Erneut versuchen
          </button>
        ) : null}
      </p>
    </div>
  )
}

export function LogDayCard(props: {
  open: boolean
  dateLabel: string
  day: TrackerLogDay | null
  shelf: ShelfItem[]
  prefillVisible: boolean
  customNameError: boolean
  canDelete: boolean
  saveState: TrackerSaveState
  onOpenChange: (open: boolean) => void
  onSelectDayType: (dayType: TrackerDayType) => void
  onCustomNameChange: (name: string) => void
  onToggleProduct: (product: TrackerLogProduct, checked: boolean) => void
  onRetry: () => void
  onDone: () => void
  onDelete: () => void
}) {
  const checkedKeys = new Set(props.day?.products.map(productKey) ?? [])
  const orderedShelf = props.day
    ? orderTrackerShelfForActivity(props.day.dayType, props.shelf)
    : { likely: [], remaining: props.shelf }
  const shelfIds = new Set(props.shelf.map((item) => item.usageId))
  const detachedProducts =
    props.day?.products.filter(
      (product) => !product.userProductUsageId || !shelfIds.has(product.userProductUsageId),
    ) ?? []
  const showProducts = props.day && props.day.dayType !== "none"

  return (
    <BottomSheet open={props.open} onOpenChange={props.onOpenChange}>
      <BottomSheetContent
        rootClassName="tracker-bottom-sheet-motion"
        className="max-h-[92dvh] border border-border sm:mx-auto sm:max-w-xl sm:rounded-[22px]"
        footer={
          <div>
            <div className="flex min-h-12 items-center justify-between gap-3">
              <SaveStatus state={props.saveState} onRetry={props.onRetry} />
              <button
                type="button"
                disabled={props.customNameError}
                onClick={props.onDone}
                className="flex h-11 min-w-[116px] items-center justify-center gap-2 rounded-xl bg-[var(--brand-coral)] px-5 font-medium text-white shadow-[0_8px_22px_rgba(var(--brand-coral-rgb),0.20)] transition-[background-color,transform] hover:bg-[var(--brand-coral-dark)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                Fertig
              </button>
            </div>
            {props.canDelete ? (
              <button
                type="button"
                onClick={props.onDelete}
                className="mt-1 h-9 w-full text-sm font-medium text-destructive hover:underline"
              >
                Eintrag entfernen
              </button>
            ) : null}
          </div>
        }
      >
        <BottomSheetHeader className="pr-12">
          <div>
            <BottomSheetTitle>Routine eintragen</BottomSheetTitle>
            <BottomSheetDescription>{props.dateLabel}</BottomSheetDescription>
          </div>
        </BottomSheetHeader>

        <div className="mt-6 space-y-6">
          <section aria-labelledby="tracker-activity-heading">
            <p className="text-[10px] font-medium uppercase text-muted-foreground">Aktivität</p>
            <h3 id="tracker-activity-heading" className="mt-1 text-base font-medium">
              Was hast du mit deinen Haaren gemacht?
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-2 max-[350px]:grid-cols-1">
              {TRACKER_DAY_TYPES.map((dayType) => {
                const selected = props.day?.dayType === dayType
                const presentation = TRACKER_ACTIVITY_PRESENTATION_DE[dayType]
                const Icon = ACTIVITY_ICONS[dayType]
                return (
                  <button
                    key={dayType}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => props.onSelectDayType(dayType)}
                    className={cn(
                      "tracker-activity-tile relative flex min-h-24 items-center gap-3 rounded-[16px] border p-3 text-left",
                      selected
                        ? "border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] text-[var(--brand-plum-darkest)] shadow-[inset_0_0_0_1px_var(--brand-plum)]"
                        : "border-[var(--brand-plum-light)] bg-background hover:bg-[var(--brand-plum-ice)]",
                    )}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-plum-ice)] text-[var(--brand-plum)]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{presentation.label}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {presentation.description}
                      </span>
                    </span>
                    {selected ? (
                      <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-plum)] text-white">
                        <Check className="h-3 w-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>

            {props.day?.dayType === "custom" ? (
              <div className="mt-3 rounded-[14px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] p-3">
                <label htmlFor="custom-activity-name" className="text-sm font-medium">
                  Wie nennst du diese Aktivität?
                </label>
                <input
                  id="custom-activity-name"
                  value={props.day.customActivityName ?? ""}
                  onChange={(event) => props.onCustomNameChange(event.target.value)}
                  maxLength={60}
                  autoFocus
                  aria-invalid={props.customNameError}
                  aria-describedby={props.customNameError ? "custom-activity-error" : undefined}
                  className="mt-2 h-11 w-full rounded-[10px] border bg-background px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder="z. B. Sauna und Kopfhautmassage"
                />
                <p
                  id="custom-activity-error"
                  className="mt-1 min-h-5 text-sm text-destructive"
                  role={props.customNameError ? "alert" : undefined}
                >
                  {props.customNameError ? "Bitte gib einen Namen ein." : ""}
                </p>
              </div>
            ) : null}
          </section>

          {showProducts ? (
            <section className="border-t pt-5" aria-labelledby="tracker-products-heading">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[10px] font-medium uppercase text-muted-foreground">
                    Produkte
                  </p>
                  <h3 id="tracker-products-heading" className="mt-1 text-base font-medium">
                    Was hast du benutzt?
                  </h3>
                </div>
                <span className="text-xs text-muted-foreground">{checkedKeys.size} ausgewählt</span>
              </div>

              {props.prefillVisible ? (
                <p className="mt-3 border-l-2 border-[var(--brand-plum)] bg-[var(--brand-plum-ice)] px-3 py-2 text-sm text-[var(--brand-plum-dark)]">
                  {TRACKER_PREFILL_SOURCE_COPY_DE}
                </p>
              ) : null}

              {orderedShelf.likely.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {orderedShelf.likely.map((item) => (
                    <ProductRow
                      key={item.usageId}
                      item={item}
                      checked={checkedKeys.has(item.usageId)}
                      onToggle={(checked) =>
                        props.onToggleProduct(
                          {
                            category: item.category,
                            productName: item.productName,
                            userProductUsageId: item.usageId,
                          },
                          checked,
                        )
                      }
                    />
                  ))}
                </div>
              ) : null}

              {orderedShelf.remaining.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {orderedShelf.likely.length > 0 ? (
                    <p className="text-xs font-medium text-muted-foreground">
                      Weitere passende Produkte
                    </p>
                  ) : null}
                  {orderedShelf.remaining.map((item) => (
                    <ProductRow
                      key={item.usageId}
                      item={item}
                      checked={checkedKeys.has(item.usageId)}
                      onToggle={(checked) =>
                        props.onToggleProduct(
                          {
                            category: item.category,
                            productName: item.productName,
                            userProductUsageId: item.usageId,
                          },
                          checked,
                        )
                      }
                    />
                  ))}
                </div>
              ) : null}

              {detachedProducts.length > 0 ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Nicht mehr in deinem Profil
                  </p>
                  {detachedProducts.map((product) => (
                    <ProductRow
                      key={productKey(product)}
                      item={{
                        usageId: productKey(product),
                        category: product.category,
                        productName: product.productName,
                        imageUrl: null,
                      }}
                      checked
                      onToggle={(checked) => props.onToggleProduct(product, checked)}
                    />
                  ))}
                </div>
              ) : null}

              {props.shelf.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Noch keine Produkte in deinem Profil.
                </p>
              ) : null}
              <p className="mt-4 text-sm text-muted-foreground">
                <Link
                  href="/profile#profile-section-products"
                  className="font-medium text-[var(--brand-plum-dark)] underline underline-offset-2"
                >
                  {TRACKER_PROFILE_DISCLAIMER_DE}
                </Link>
              </p>
            </section>
          ) : null}
        </div>
      </BottomSheetContent>
    </BottomSheet>
  )
}
