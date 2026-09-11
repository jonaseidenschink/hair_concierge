import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"

/**
 * The five catalog products the T12 „Beispiel" pages are built from.
 *
 * Every one is a REAL, reviewed catalog entry — ids, display names and image URLs are
 * copied verbatim from `src/lib/quiz/offer-preview-products.ts` (the reviewed catalog
 * snapshot the offer preview already ships) so the example never invents a product that
 * a user could then fail to find. Routine and Anwendung read the same five, which is what
 * makes the two example pages tell one coherent story.
 *
 * The archetype is the standard test account: a complete profile with wavy, normal-thick
 * hair and dry lengths — cleanse, condition, one weekly mask, a leave-in, and an optional
 * finishing oil.
 */
export type GatedExampleProduct = {
  productId: string
  displayName: string
  imageUrl: string
  category: PersonalPlanCategory
}

export const GATED_EXAMPLE_PRODUCTS = {
  shampoo: {
    productId: "ead1333b-6839-464d-b272-673d39bb95a4",
    displayName: "Balea Aqua Hyaluron",
    imageUrl:
      "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-04/ead1333b-6839-464d-b272-673d39bb95a4/02-ead1333b-6839-464d-b272-673d39bb95a4-balea-balea-aqua-hyaluron-f41a5b48efe1.webp",
    category: "shampoo",
  },
  conditioner: {
    productId: "2a159694-6799-4be7-a0aa-572757c94801",
    displayName: "Langhaarmädchen Lovely Long Conditioner",
    imageUrl:
      "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-01/2a159694-6799-4be7-a0aa-572757c94801/31-2a159694-6799-4be7-a0aa-572757c94801-langhaarmadchen-langhaarmadchen-lovely-long-d30fd7fd3ec3.webp",
    category: "conditioner",
  },
  mask: {
    productId: "c7326c6b-6175-4ec2-865f-68baf476c986",
    displayName: "Guhl 30 sec. Feuchtigkeit",
    imageUrl:
      "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-02/c7326c6b-6175-4ec2-865f-68baf476c986/17-c7326c6b-6175-4ec2-865f-68baf476c986-guhl-guhl-30-sec-feuchtigkeit-27b4f1343260.webp",
    category: "mask",
  },
  leaveIn: {
    productId: "0b21f996-bb42-4b10-89bd-4881c4346d53",
    displayName: "Isana Feuchtigkeits Leave-In (Hyaluron)",
    imageUrl:
      "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-02/0b21f996-bb42-4b10-89bd-4881c4346d53/22-0b21f996-bb42-4b10-89bd-4881c4346d53-isana-isana-feuchtigkeits-leave-in-hyaluron-ba1624f6c1eb.webp",
    category: "leave_in",
  },
  oil: {
    productId: "7d8c0150-778d-4cb9-abf5-bfc16ad93b12",
    displayName: "Olaplex No.7 Bonding Oil",
    imageUrl:
      "https://pqdkhefxsxkyeqelqegq.supabase.co/storage/v1/object/public/product-images/catalog-2026-06-10-03/7d8c0150-778d-4cb9-abf5-bfc16ad93b12/34-7d8c0150-778d-4cb9-abf5-bfc16ad93b12-olaplex-olaplex-no-7-bonding-oil-5dc5795db1a8.webp",
    category: "oil",
  },
} as const satisfies Record<string, GatedExampleProduct>
