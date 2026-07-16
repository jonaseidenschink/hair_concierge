import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import { NextRequest } from "next/server"
import { renderToStaticMarkup } from "react-dom/server"

import { classifyRoute, type RouteEnvironment } from "../src/lib/auth/route-classification"
import { size as iconSize } from "../src/app/icon"
import robots from "../src/app/robots"
import { config as proxyConfig, proxy } from "../src/proxy"
import { isAdminRoutePath } from "../src/lib/supabase/middleware"
import { JsonLd, serializeJsonLd } from "../src/components/seo/json-ld"
import { nextConfig } from "../next.config"
import {
  HOME_METADATA,
  LEGAL_PAGE_METADATA,
  METHODIK_METADATA,
  ORGANIZATION_JSON_LD,
  PRIVATE_PAGE_METADATA,
  PRICING_METADATA,
  QUIZ_METADATA,
  ROOT_METADATA,
  SITE_DEFAULT_DESCRIPTION,
  SITE_LEGAL_NAME,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_SHARE_IMAGE_URL,
  SITE_SAME_AS,
  WEBSITE_JSON_LD,
} from "../src/lib/seo/site-identity"

const production: RouteEnvironment = {
  nodeEnv: "production",
  localDevLoginEnabled: false,
}

const development: RouteEnvironment = {
  nodeEnv: "development",
  localDevLoginEnabled: false,
}

const localDevelopment: RouteEnvironment = {
  nodeEnv: "development",
  localDevLoginEnabled: true,
}

test("classifies every current public page and route handler", () => {
  const publicRoutes = [
    "/",
    "/agb",
    "/auth",
    "/auth/confirm",
    "/auth/update-password",
    "/datenschutz",
    "/icon",
    "/impressum",
    "/kontakt",
    "/lp/campaign-example",
    "/methodik",
    "/opengraph-image",
    "/pricing",
    "/quiz",
    "/result/lead-123",
    "/robots.txt",
    "/sitemap.xml",
    "/twitter-image",
    "/welcome",
    "/widerruf",
    "/api/auth/callback",
    "/api/auth/send-magic-link",
    "/api/auth/send-setup-link",
    "/api/auth/set-checkout-password",
    "/api/funnel/session",
    "/api/og/result/lead-123",
    "/api/paypal/activation-status",
    "/api/paypal/approve-subscription",
    "/api/paypal/cancel-subscription",
    "/api/paypal/create-subscription-intent",
    "/api/paypal/webhook",
    "/api/quiz/analyze",
    "/api/quiz/lead",
    "/api/quiz/result-artifact",
    "/api/stripe/create-checkout-session",
    "/api/stripe/portal-session",
    "/api/stripe/session",
    "/api/stripe/webhook",
  ]

  for (const pathname of publicRoutes) {
    assert.equal(classifyRoute(pathname, production), "public", pathname)
  }
})

test("classifies every current protected page and API route", () => {
  const protectedRoutes = [
    "/admin",
    "/admin/articles",
    "/admin/conversations",
    "/admin/conversations/example",
    "/admin/products",
    "/admin/quotes",
    "/admin/users",
    "/chat",
    "/chat/example",
    "/onboarding",
    "/profile",
    "/profile/edit/goals",
    "/routine",
    "/api/admin/articles",
    "/api/admin/articles/example",
    "/api/admin/conversations",
    "/api/admin/conversations/example",
    "/api/admin/products",
    "/api/admin/products/example",
    "/api/admin/quotes",
    "/api/admin/quotes/example",
    "/api/admin/users",
    "/api/billing/access",
    "/api/billing/reconcile",
    "/api/chat",
    "/api/chat/example",
    "/api/chat/feedback",
    "/api/chat/product-selection",
    "/api/chat/trigger",
    "/api/feedback",
    "/api/memory",
    "/api/memory/example",
    "/api/product-intake/brand-options",
    "/api/product-intake/chat",
    "/api/product-intake/onboarding",
    "/api/product-intake/onboarding/cancel",
    "/api/product-intake/upload",
    "/api/products",
    "/api/profile",
    "/api/routine",
    "/api/routine/products",
    "/api/routine/products/example",
    "/api/routine/suggestions/example/dismiss",
    "/api/tracker",
    "/api/tracker/dismiss-nudge",
    "/api/tracker/log",
    "/tracker",
  ]

  for (const pathname of protectedRoutes) {
    assert.equal(classifyRoute(pathname, production), "protected", pathname)
  }
})

test("does not leave any current route handler outside the explicit inventory", () => {
  const routeFiles = readdirSync("src/app", { recursive: true, encoding: "utf8" }).filter(
    (path) => path.endsWith("/route.ts") || path.endsWith("/route.tsx"),
  )

  assert.ok(routeFiles.length > 0)
  for (const routeFile of routeFiles) {
    const routeSegments = routeFile
      .replace(/\/route\.tsx?$/, "")
      .split("/")
      .map((segment) => (segment.startsWith("[") ? "example" : segment))
    const pathname = `/${routeSegments.join("/")}`

    assert.notEqual(classifyRoute(pathname, production), "unknown", routeFile)
  }
})

test("does not leave any current page route outside the explicit inventory", () => {
  const pageFiles = readdirSync("src/app", { recursive: true, encoding: "utf8" }).filter(
    (path) => path.endsWith("/page.ts") || path.endsWith("/page.tsx") || path === "page.tsx",
  )

  assert.ok(pageFiles.length > 0)
  for (const pageFile of pageFiles) {
    const segments = pageFile
      .replace(/\/?page\.tsx?$/, "")
      .split("/")
      .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("@"))
      .map((segment) => (segment.startsWith("[") ? "example" : segment))
    const pathname = `/${segments.join("/")}`

    assert.notEqual(classifyRoute(pathname, production), "unknown", pageFile)
  }
})

test("preserves environment-conditional development routes", () => {
  for (const pathname of [
    "/labs/agent-compare",
    "/api/labs/agent-compare",
    "/api/labs/agent-compare/judgments",
    "/api/debug/build-info",
  ]) {
    assert.equal(classifyRoute(pathname, development), "development", pathname)
    assert.equal(classifyRoute(pathname, production), "protected", pathname)
  }

  assert.equal(classifyRoute("/api/dev/login", localDevelopment), "development")
  assert.equal(classifyRoute("/api/dev/login", development), "protected")
  assert.equal(classifyRoute("/api/dev/login", production), "protected")
})

test("classifies the exact legacy offer route", () => {
  assert.equal(classifyRoute("/offer", production), "legacy")
  assert.equal(classifyRoute("/offer/details", production), "unknown")
})

test("uses segment-aware prefixes and leaves unknown routes to Next.js", () => {
  for (const pathname of [
    "/administer",
    "/api/stripefake",
    "/authentic",
    "/result-leaked",
    "/does-not-exist-seo-check",
    "/api/does-not-exist-seo-check",
  ]) {
    assert.equal(classifyRoute(pathname, production), "unknown", pathname)
  }
})

test("admin pages and APIs retain the middleware role-check boundary", () => {
  assert.equal(isAdminRoutePath("/admin"), true)
  assert.equal(isAdminRoutePath("/admin/products"), true)
  assert.equal(isAdminRoutePath("/api/admin/articles"), true)
  assert.equal(isAdminRoutePath("/administer"), false)
  assert.equal(isAdminRoutePath("/api/administrator"), false)
})

test("robots allows public content, hints private routes away, and declares the sitemap", () => {
  const metadata = robots()
  const rules = Array.isArray(metadata.rules) ? metadata.rules : [metadata.rules]
  const wildcardRule = rules.find((rule) => rule.userAgent === "*")

  assert.ok(wildcardRule)
  assert.equal(wildcardRule.allow, "/")
  assert.equal(metadata.sitemap, "https://chaarlie.de/sitemap.xml")

  const disallowed = Array.isArray(wildcardRule.disallow)
    ? wildcardRule.disallow
    : [wildcardRule.disallow]
  for (const pathname of [
    "/admin",
    "/api/",
    "/auth",
    "/chat",
    "/labs",
    "/onboarding",
    "/profile",
    "/result/",
    "/routine",
    "/welcome",
  ]) {
    assert.ok(disallowed.includes(pathname), pathname)
  }
  assert.ok(!disallowed.includes("/quiz"))
})

test("proxy matcher keeps crawler resources inside canonical-host handling", () => {
  const matcher = proxyConfig.matcher.join("\n")

  assert.ok(!matcher.includes("robots\\.txt$"))
  assert.ok(!matcher.includes("sitemap\\.xml$"))
})

test("proxy canonicalizes crawler resources from www to the apex host", async () => {
  for (const pathname of ["/robots.txt", "/sitemap.xml"]) {
    const response = await proxy(new NextRequest(`https://www.chaarlie.de${pathname}`))

    assert.equal(response.status, 308)
    assert.equal(response.headers.get("location"), `https://chaarlie.de${pathname}`)
  }
})

test("site identity contains only truthful, stable facts", () => {
  assert.equal(SITE_ORIGIN, "https://chaarlie.de")
  assert.equal(SITE_NAME, "Chaarlie")
  assert.equal(SITE_LEGAL_NAME, "Haarmony LLC")
  assert.match(SITE_DEFAULT_DESCRIPTION, /Haaranalyse/)
  assert.deepEqual(SITE_SAME_AS, [])
})

test("root metadata provides a title template without a homepage social URL", () => {
  assert.deepEqual(ROOT_METADATA.title, {
    default: "Chaarlie — Dein persönlicher Haarpflege-Berater",
    template: "%s | Chaarlie",
  })
  assert.equal(ROOT_METADATA.openGraph?.url, undefined)
  assert.equal(ROOT_METADATA.openGraph?.title, undefined)
  assert.equal(ROOT_METADATA.robots, undefined)
})

test("static public routes have unique metadata and self-canonicals", () => {
  const routes = [
    ["/", HOME_METADATA],
    ["/quiz", QUIZ_METADATA],
    ["/pricing", PRICING_METADATA],
    ["/kontakt", LEGAL_PAGE_METADATA.kontakt],
    ["/impressum", LEGAL_PAGE_METADATA.impressum],
    ["/datenschutz", LEGAL_PAGE_METADATA.datenschutz],
    ["/agb", LEGAL_PAGE_METADATA.agb],
    ["/widerruf", LEGAL_PAGE_METADATA.widerruf],
    ["/methodik", METHODIK_METADATA],
  ] as const

  const titles = new Set<unknown>()
  const descriptions = new Set<unknown>()
  for (const [pathname, metadata] of routes) {
    assert.equal(metadata.alternates?.canonical, pathname, pathname)
    assert.equal(metadata.openGraph?.url, pathname, pathname)
    assert.deepEqual(metadata.openGraph?.images, [SITE_SHARE_IMAGE_URL], pathname)
    assert.ok(metadata.title, pathname)
    assert.ok(metadata.description, pathname)
    titles.add(metadata.title)
    descriptions.add(metadata.description)
  }

  assert.equal(titles.size, routes.length)
  assert.equal(descriptions.size, routes.length)
})

test("quiz is indexable while pricing is noindex and nofollow", () => {
  assert.deepEqual(QUIZ_METADATA.robots, { index: true, follow: true })
  assert.deepEqual(PRICING_METADATA.robots, { index: false, follow: false })
})

test("the indexable quiz entry state exposes one primary question heading", () => {
  const source = readFileSync("src/components/quiz/quiz-question.tsx", "utf8")

  assert.match(source, /<h1[^>]*>\{question\.title\}<\/h1>/)
})

test("private layouts share an explicit noindex and nofollow contract", () => {
  assert.deepEqual(PRIVATE_PAGE_METADATA.robots, { index: false, follow: false })
})

test("private and unstable routes receive response-level noindex headers", async () => {
  const headerRules = await nextConfig.headers?.()
  const noindexSources =
    headerRules
      ?.filter((rule) =>
        rule.headers.some(
          (header) => header.key === "X-Robots-Tag" && header.value === "noindex, nofollow",
        ),
      )
      .map((rule) => rule.source) ?? []

  for (const source of [
    "/admin/:path*",
    "/auth/:path*",
    "/chat/:path*",
    "/labs/:path*",
    "/onboarding/:path*",
    "/pricing/:path*",
    "/profile/:path*",
    "/result/:path*",
    "/routine/:path*",
    "/welcome/:path*",
  ]) {
    assert.ok(noindexSources.includes(source), source)
  }
})

test("homepage structured data links stable Organization and WebSite identities", () => {
  assert.equal(ORGANIZATION_JSON_LD["@type"], "Organization")
  assert.equal(ORGANIZATION_JSON_LD["@id"], "https://chaarlie.de/#organization")
  assert.equal(ORGANIZATION_JSON_LD.legalName, "Haarmony LLC")
  assert.equal(ORGANIZATION_JSON_LD.logo.width, 512)
  assert.equal(ORGANIZATION_JSON_LD.logo.height, 512)
  assert.deepEqual(iconSize, { width: 512, height: 512 })
  assert.ok(!("sameAs" in ORGANIZATION_JSON_LD))

  assert.equal(WEBSITE_JSON_LD["@type"], "WebSite")
  assert.equal(WEBSITE_JSON_LD["@id"], "https://chaarlie.de/#website")
  assert.deepEqual(WEBSITE_JSON_LD.publisher, {
    "@id": "https://chaarlie.de/#organization",
  })
})

test("JSON-LD serializer prevents script-closing injection", () => {
  const data = {
    "@context": "https://schema.org",
    name: "</script><script>alert('x')</script>",
  }
  const serialized = serializeJsonLd(data)
  const html = renderToStaticMarkup(JsonLd({ data }))

  assert.ok(!serialized.includes("<"))
  assert.match(serialized, /\\u003c\/script>/)
  assert.match(html, /type="application\/ld\+json"/)
  assert.ok(html.includes("\\u003c/script>"))
})
