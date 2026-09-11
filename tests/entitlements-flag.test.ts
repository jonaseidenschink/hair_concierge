import assert from "node:assert/strict"
import test from "node:test"

import { isFreemiumScannerFirstEnabled } from "../src/lib/entitlements/flag"

test("isFreemiumScannerFirstEnabled is false when the env var is unset", () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED
  delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED

  try {
    assert.equal(isFreemiumScannerFirstEnabled(), false)
  } finally {
    if (original === undefined) {
      delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    } else {
      process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
    }
  }
})

test("isFreemiumScannerFirstEnabled is false for any value other than the literal string true", () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED

  try {
    process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "1"
    assert.equal(isFreemiumScannerFirstEnabled(), false)

    process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "True"
    assert.equal(isFreemiumScannerFirstEnabled(), false)

    process.env.FREEMIUM_SCANNER_FIRST_ENABLED = ""
    assert.equal(isFreemiumScannerFirstEnabled(), false)
  } finally {
    if (original === undefined) {
      delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    } else {
      process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
    }
  }
})

test("isFreemiumScannerFirstEnabled is true when set to the literal string true", () => {
  const original = process.env.FREEMIUM_SCANNER_FIRST_ENABLED

  try {
    process.env.FREEMIUM_SCANNER_FIRST_ENABLED = "true"
    assert.equal(isFreemiumScannerFirstEnabled(), true)
  } finally {
    if (original === undefined) {
      delete process.env.FREEMIUM_SCANNER_FIRST_ENABLED
    } else {
      process.env.FREEMIUM_SCANNER_FIRST_ENABLED = original
    }
  }
})
