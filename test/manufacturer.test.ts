import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  BleScanner,
  normalizeSerial,
  parseSerial,
  preferSerial,
  serialsReferToSameDevice,
} from "../src/ble/scanner.js"
import { MFCT_ID } from "../src/airthings/const.js"
import type { Logging } from "homebridge"

describe("manufacturer data serial parse", () => {
  it("parses serial with company id prefix", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE(MFCT_ID, 0)
    buf.writeUInt32LE(2930123456, 2)
    assert.equal(parseSerial(buf), "2930123456")
  })

  it("rejects stripped 4-byte payload without allowStrippedPayload", () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(123456, 0)
    assert.equal(parseSerial(buf), null)
  })

  it("parses stripped payload when allowStrippedPayload is set", () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(123456, 0)
    assert.equal(parseSerial(buf, { allowStrippedPayload: true }), "123456")
  })

  it("returns null for non-airthings company id", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE(0x004c, 0)
    buf.writeUInt32LE(1, 2)
    assert.equal(parseSerial(buf), null)
  })

  it("normalizes serial numbers from json numbers", () => {
    assert.equal(normalizeSerial(2930123456), "2930123456")
    assert.equal(normalizeSerial(" 2930 "), "2930")
  })
})

describe("serial identity", () => {
  it("treats 10-digit manufacturer serial and short gatt serial as the same device", () => {
    assert.equal(serialsReferToSameDevice("3220001333", "001333"), true)
    assert.equal(serialsReferToSameDevice("001333", "3220001333"), true)
    assert.equal(serialsReferToSameDevice("3220001333", "3220001333"), true)
  })

  it("does not merge unrelated serials", () => {
    assert.equal(serialsReferToSameDevice("3220001333", "2930123456"), false)
    assert.equal(serialsReferToSameDevice("3220001333", "001334"), false)
    assert.equal(serialsReferToSameDevice("123456", "654321"), false)
  })

  it("prefers the 10-digit manufacturer serial", () => {
    assert.equal(preferSerial("3220001333", "001333"), "3220001333")
    assert.equal(preferSerial("001333", "3220001333"), "3220001333")
  })
})

function mockLog(): Logging {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as Logging
}

describe("scanner address merge", () => {
  const address = "b0:d2:78:60:5d:4f"

  function makeScanner() {
    return new BleScanner(mockLog(), {
      scanDurationSec: 5,
      refreshIntervalSec: 300,
      isMetric: true,
      debug: false,
      devices: [
        { serialNumber: "3220001333", address, name: "Wave Enhance" },
      ],
    })
  }

  it("keeps one device when short and full serials share an address", () => {
    const scanner = makeScanner()
    scanner.seedKnownDevice({
      serialNumber: "3220001333",
      address,
      displayName: "Wave Enhance",
    })
    scanner.seedKnownDevice({
      serialNumber: "001333",
      address,
      displayName: "Wave Enhance",
    })
    const found = scanner.getDiscovered()
    assert.equal(found.length, 1)
    assert.equal(found[0].serialNumber, "3220001333")
    assert.equal(found[0].address, address)
  })

  it("upgrades a short cached serial when the manufacturer serial is seeded later", () => {
    const scanner = makeScanner()
    scanner.seedKnownDevice({
      serialNumber: "001333",
      address,
      displayName: "Wave Enhance",
    })
    scanner.seedKnownDevice({
      serialNumber: "3220001333",
      address,
      displayName: "Wave Enhance",
    })
    const found = scanner.getDiscovered()
    assert.equal(found.length, 1)
    assert.equal(found[0].serialNumber, "3220001333")
  })

  it("uses the configured serial as identity even if only the gatt serial is seeded", () => {
    const scanner = makeScanner()
    scanner.seedKnownDevice({
      serialNumber: "001333",
      address,
      displayName: "Wave Enhance",
    })
    const found = scanner.getDiscovered()
    assert.equal(found.length, 1)
    assert.equal(found[0].serialNumber, "3220001333")
    assert.equal(found[0].displayName, "Wave Enhance")
  })

  it("does not merge different addresses", () => {
    const scanner = makeScanner()
    scanner.seedKnownDevice({
      serialNumber: "3220001333",
      address,
      displayName: "Wave Enhance",
    })
    scanner.seedKnownDevice({
      serialNumber: "2930123456",
      address: "aa:bb:cc:dd:ee:ff",
      displayName: "Wave Plus",
    })
    assert.equal(scanner.getDiscovered().length, 2)
  })
})
