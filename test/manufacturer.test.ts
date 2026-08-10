import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeSerial, parseSerial } from "../src/ble/scanner.js"
import { MFCT_ID } from "../src/airthings/const.js"

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
