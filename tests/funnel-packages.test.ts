import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_FUNNEL_PACKAGE_KEY,
  getFunnelPackageByKey,
  getFunnelPackageBySlug,
  resolveDefaultFunnelPackage,
  resolveOfferVariantForSession,
  validateFunnelPackages,
} from "../src/lib/funnel/packages"

test("resolves the default organic package", () => {
  const funnelPackage = resolveDefaultFunnelPackage()

  assert.equal(funnelPackage.key, DEFAULT_FUNNEL_PACKAGE_KEY)
  assert.equal(funnelPackage.slug, null)
  assert.equal(funnelPackage.offerVariant, "app-value-stack")
})

test("resolves the active Meta routine package separately from organic", () => {
  const organicPackage = resolveDefaultFunnelPackage()
  const metaPackage = getFunnelPackageBySlug("routine")

  assert.equal(metaPackage?.key, "meta_routine_v1")
  assert.equal(metaPackage?.channel, "meta")
  assert.equal(metaPackage?.status, "active")
  assert.notEqual(metaPackage?.key, organicPackage.key)
  assert.equal(metaPackage?.landingVariant, organicPackage.landingVariant)
  assert.equal(metaPackage?.offerVariant, organicPackage.offerVariant)
})

test("resolves the placeholder campaign package by slug", () => {
  const funnelPackage = getFunnelPackageBySlug("scalp-check")
  assert.equal(funnelPackage?.key, "scalp_check_placeholder")
  assert.equal(funnelPackage?.status, "placeholder")
})

test("unknown package keys and slugs do not fall back silently", () => {
  assert.equal(getFunnelPackageByKey("unknown"), null)
  assert.equal(getFunnelPackageBySlug("unknown"), null)
})

test("structured package definitions reject duplicate keys and slugs", () => {
  const base = resolveDefaultFunnelPackage()
  assert.throws(() => validateFunnelPackages([base, { ...base }]), /Duplicate funnel package key/)
  assert.throws(
    () =>
      validateFunnelPackages([
        base,
        { ...base, key: "another_package", slug: "same-slug" },
        { ...base, key: "third_package", slug: "same-slug" },
      ]),
    /Duplicate funnel package slug/,
  )
})

test("stored session offer variant wins over the current package mapping", () => {
  assert.equal(
    resolveOfferVariantForSession({
      packageKey: "default_organic",
      offerVariant: "default",
    }),
    "default",
  )
})

test("a session without a stored offer uses its package mapping", () => {
  assert.equal(
    resolveOfferVariantForSession({ packageKey: "meta_routine_v1", offerVariant: null }),
    "app-value-stack",
  )
})
