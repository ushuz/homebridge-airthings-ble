import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseSerial } from "../src/ble/scanner.js"
import { MFCT_ID } from "../src/airthings/const.js"

describe("manufacturer data serial parse", () => {
  it("parses serial with company id prefix", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE(MFCT_ID, 0)
    buf.writeUInt32LE(2930123456, 2)
    assert.equal(parseSerial(buf), "2930123456")
  })

  it("parses serial payload without company id", () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(123456, 0)
    assert.equal(parseSerial(buf), "123456")
  })

  it("returns null for non-airthings company id", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE(0x004c, 0)
    buf.writeUInt32LE(1, 2)
    assert.equal(parseSerial(buf), null)
  })
})
