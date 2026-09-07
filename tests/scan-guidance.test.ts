import assert from "node:assert/strict"
import test from "node:test"

import {
  HINT_HYSTERESIS_MS,
  LOW_LIGHT_LUMA_THRESHOLD,
  SCAN_CONFIRM_LABEL,
  SCAN_HINT_DEFAULT,
  SCAN_HINT_LESS_TILT,
  SCAN_HINT_MORE_LIGHT,
  SCAN_HINT_MOVE_CLOSER,
  SCAN_HINT_SPOTTED,
  SMALL_BOUNDING_BOX_RATIO_THRESHOLD,
  TILT_RAW_DETECTION_THRESHOLD,
  nextScanHint,
  type ScanTelemetry,
} from "../src/lib/scan/guidance"

const baseTelemetry: ScanTelemetry = {
  msSinceStart: 0,
  msSinceLastDetection: 0,
  lastBoundingBoxRatio: null,
  meanLuma: null,
  rawDetectionsWithoutStableRead: 0,
}

test("nextScanHint: null currentHint -> default hint (no signals)", () => {
  const result = nextScanHint(baseTelemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_DEFAULT)
})

test("nextScanHint: low light triggers Mehr Licht hilft", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: LOW_LIGHT_LUMA_THRESHOLD - 1 }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_MORE_LIGHT)
})

test("nextScanHint: luma exactly at threshold does not trigger low-light hint", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: LOW_LIGHT_LUMA_THRESHOLD }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_DEFAULT)
})

test("nextScanHint: raw detections without stable read trigger Weniger kippen", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 200,
    rawDetectionsWithoutStableRead: TILT_RAW_DETECTION_THRESHOLD,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_LESS_TILT)
})

test("nextScanHint: raw detections below threshold do not trigger Weniger kippen", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 200,
    rawDetectionsWithoutStableRead: TILT_RAW_DETECTION_THRESHOLD - 1,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_DEFAULT)
})

test("nextScanHint: small bounding box triggers Etwas näher ran", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 200,
    lastBoundingBoxRatio: SMALL_BOUNDING_BOX_RATIO_THRESHOLD - 0.01,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_MOVE_CLOSER)
})

test("nextScanHint: bounding box ratio exactly at threshold does not trigger", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 200,
    lastBoundingBoxRatio: SMALL_BOUNDING_BOX_RATIO_THRESHOLD,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_DEFAULT)
})

test("nextScanHint: priority conflict — low light wins over small box", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 10,
    lastBoundingBoxRatio: 0.01,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_MORE_LIGHT)
})

test("nextScanHint: priority conflict — low light wins over tilt", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 10,
    rawDetectionsWithoutStableRead: TILT_RAW_DETECTION_THRESHOLD,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_MORE_LIGHT)
})

test("nextScanHint: priority conflict — tilt wins over small box", () => {
  const telemetry: ScanTelemetry = {
    ...baseTelemetry,
    meanLuma: 200,
    rawDetectionsWithoutStableRead: TILT_RAW_DETECTION_THRESHOLD,
    lastBoundingBoxRatio: 0.01,
  }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_LESS_TILT)
})

test("nextScanHint: hysteresis holds — desired hint differs but time under threshold -> null", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: 10 }
  const result = nextScanHint(telemetry, {
    currentHint: SCAN_HINT_DEFAULT,
    msSinceLastHintChange: HINT_HYSTERESIS_MS - 1,
  })
  assert.equal(result, null)
})

test("nextScanHint: hysteresis releases — time at/over threshold -> new hint", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: 10 }
  const result = nextScanHint(telemetry, {
    currentHint: SCAN_HINT_DEFAULT,
    msSinceLastHintChange: HINT_HYSTERESIS_MS,
  })
  assert.equal(result, SCAN_HINT_MORE_LIGHT)
})

test("nextScanHint: no change needed when desired equals current -> null regardless of timer", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: 10 }
  const result = nextScanHint(telemetry, {
    currentHint: SCAN_HINT_MORE_LIGHT,
    msSinceLastHintChange: 0,
  })
  assert.equal(result, null)
})

test("nextScanHint: null currentHint bypasses hysteresis even with large elapsed time already implied", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, meanLuma: 10 }
  const result = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
  assert.equal(result, SCAN_HINT_MORE_LIGHT)
})

test("nextScanHint: pure function — same inputs produce same output, no internal state leakage", () => {
  const telemetry: ScanTelemetry = { ...baseTelemetry, rawDetectionsWithoutStableRead: 5 }
  const state = { currentHint: null, msSinceLastHintChange: 0 } as const
  const first = nextScanHint(telemetry, state)
  const second = nextScanHint(telemetry, state)
  assert.equal(first, second)
})

/**
 * The viewfinder's copy chain (plan 2026-09-05): the idle pill says what the scanner is
 * doing, the spotted pill asks for the one thing that helps, and the confirm pill no
 * longer claims a result ("Barcode erkannt") right before an unknown-product sheet.
 */
test("scan pill copy: the viewfinder strings are the signed-off German", () => {
  assert.equal(SCAN_HINT_DEFAULT, "Suche Barcode …")
  assert.equal(SCAN_HINT_SPOTTED, "Barcode gefunden – kurz stillhalten")
  assert.equal(SCAN_CONFIRM_LABEL, "Gelesen – wird geprüft")
})

test("nextScanHint never returns the spotted pill: it is a detection state, not a hint", () => {
  const candidates = [
    { ...baseTelemetry },
    { ...baseTelemetry, meanLuma: 10 },
    { ...baseTelemetry, meanLuma: 200, rawDetectionsWithoutStableRead: 9 },
    { ...baseTelemetry, meanLuma: 200, lastBoundingBoxRatio: 0.001 },
  ] satisfies ScanTelemetry[]
  for (const telemetry of candidates) {
    const hint = nextScanHint(telemetry, { currentHint: null, msSinceLastHintChange: 0 })
    assert.notEqual(hint as string, SCAN_HINT_SPOTTED as string)
  }
})
