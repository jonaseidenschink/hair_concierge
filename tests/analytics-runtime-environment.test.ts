import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { shouldInitializeBrowserVendorAnalytics } from "../src/lib/analytics/runtime/environment"

test("browser vendor analytics stay disabled on local hosts unless explicitly enabled", () => {
  for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(shouldInitializeBrowserVendorAnalytics(hostname, false), false, hostname)
    assert.equal(shouldInitializeBrowserVendorAnalytics(hostname, true), true, hostname)
  }

  assert.equal(shouldInitializeBrowserVendorAnalytics("chaarlie.de", false), true)
})

test("analytics coordinator applies the environment gate to all vendor releases", () => {
  const source = readFileSync("src/providers/analytics-runtime-coordinator.tsx", "utf8")
  const gate = source.indexOf("if (!shouldInitializeBrowserVendorAnalytics")

  assert.ok(gate >= 0)
  for (const release of [
    "initMetaPixel()",
    "startCustomerIoBrowserTracking()",
    "releasePostHogRuntime()",
  ]) {
    assert.ok(source.indexOf(release) > gate, `${release} must remain behind the local-host gate`)
  }
})
