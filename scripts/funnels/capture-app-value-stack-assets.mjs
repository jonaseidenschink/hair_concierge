#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import path from "node:path"

import { chromium } from "playwright"

const baseUrl = process.argv[2] ?? "http://localhost:3000"
const outputDir = path.resolve("public/images/funnels/app-value-stack")

const captures = [
  ["routine", "app-routine.png", 3],
  ["product", "app-product-details.png", 1],
  ["chat", "app-chat.png", 0],
]

await mkdir(outputDir, { recursive: true })
const stagingDir = await mkdtemp(path.join(outputDir, ".capture-"))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  deviceScaleFactor: 1,
  viewport: { width: 390, height: 844 },
})

await context.addInitScript(() => {
  window.localStorage.setItem(
    "chaarlie_cookie_consent_v1",
    JSON.stringify({ essential: true, analytics: false, marketing: false, ts: Date.now() }),
  )
})

try {
  const page = await context.newPage()

  for (const [state, filename, expectedImageCount] of captures) {
    const response = await page.goto(`${baseUrl}/labs/app-proof?state=${state}`, {
      waitUntil: "networkidle",
    })
    if (!response?.ok()) {
      throw new Error(
        `Could not capture ${state}: received HTTP ${response?.status() ?? "unknown"}`,
      )
    }

    const fixture = page.getByTestId("app-proof-fixture")
    await fixture.waitFor({ state: "visible" })
    const renderedState = await fixture.getAttribute("data-state")
    if (renderedState !== state) {
      throw new Error(`Could not capture ${state}: fixture rendered ${renderedState ?? "no state"}`)
    }

    const images = page.locator("img")
    await page.waitForFunction((count) => {
      const renderedImages = [...document.images]
      return (
        renderedImages.length === count &&
        renderedImages.every((image) => image.complete && image.naturalWidth > 0)
      )
    }, expectedImageCount)
    if ((await images.count()) !== expectedImageCount) {
      throw new Error(`Could not capture ${state}: unexpected image count`)
    }

    await page.locator("nextjs-portal").evaluateAll((portals) => {
      portals.forEach((portal) => portal.remove())
    })
    await page.screenshot({ path: path.join(stagingDir, filename) })
  }

  for (const [, filename] of captures) {
    await rename(path.join(stagingDir, filename), path.join(outputDir, filename))
    console.log(`Captured ${filename}`)
  }
} finally {
  await browser.close()
  await rm(stagingDir, { force: true, recursive: true })
}
