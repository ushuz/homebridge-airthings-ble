import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { afterEach, describe, it } from "node:test"
import {
  bleAdapterLockPath,
  withBleAdapterLock,
} from "../src/ble/adapterLock.js"

const HCI = 97 // avoid colliding with live homebridge locks

afterEach(() => {
  try {
    rmSync(bleAdapterLockPath(HCI), { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("withBleAdapterLock", () => {
  it("serializes concurrent holders", async () => {
    const order: string[] = []

    const a = withBleAdapterLock(
      { owner: "a", hciDeviceId: HCI, pollIntervalMs: 20, acquireTimeoutMs: 5000 },
      async () => {
        order.push("a-start")
        await new Promise((r) => setTimeout(r, 80))
        order.push("a-end")
        return "a"
      },
    )

    // let a grab the lock first
    await new Promise((r) => setTimeout(r, 10))

    const b = withBleAdapterLock(
      { owner: "b", hciDeviceId: HCI, pollIntervalMs: 20, acquireTimeoutMs: 5000 },
      async () => {
        order.push("b-start")
        order.push("b-end")
        return "b"
      },
    )

    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra, "a")
    assert.equal(rb, "b")
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"])
  })

  it("releases after failure so the next holder can run", async () => {
    await assert.rejects(
      () =>
        withBleAdapterLock(
          { owner: "fail", hciDeviceId: HCI, acquireTimeoutMs: 2000 },
          async () => {
            throw new Error("boom")
          },
        ),
      /boom/,
    )

    const result = await withBleAdapterLock(
      { owner: "ok", hciDeviceId: HCI, acquireTimeoutMs: 2000 },
      async () => "ok",
    )
    assert.equal(result, "ok")
  })

  it("times out when the lock is never released", async () => {
    // hold without releasing by stealing the open path: run a long holder
    const holder = withBleAdapterLock(
      { owner: "holder", hciDeviceId: HCI, acquireTimeoutMs: 5000 },
      async () => {
        await new Promise((r) => setTimeout(r, 400))
      },
    )

    await new Promise((r) => setTimeout(r, 10))

    await assert.rejects(
      () =>
        withBleAdapterLock(
          {
            owner: "waiter",
            hciDeviceId: HCI,
            pollIntervalMs: 20,
            acquireTimeoutMs: 80,
          },
          async () => "never",
        ),
      /timed out/,
    )

    await holder
  })

  it("does not age-steal a live holder", async () => {
    const order: string[] = []
    const holder = withBleAdapterLock(
      { owner: "holder", hciDeviceId: HCI, acquireTimeoutMs: 5000 },
      async () => {
        order.push("hold-start")
        await new Promise((r) => setTimeout(r, 150))
        order.push("hold-end")
      },
    )

    await new Promise((r) => setTimeout(r, 10))

    // tiny staleMs must not interrupt a live process
    await assert.rejects(
      () =>
        withBleAdapterLock(
          {
            owner: "thief",
            hciDeviceId: HCI,
            staleMs: 1,
            pollIntervalMs: 20,
            acquireTimeoutMs: 80,
          },
          async () => {
            order.push("stolen")
          },
        ),
      /timed out/,
    )

    await holder
    assert.deepEqual(order, ["hold-start", "hold-end"])
  })
})
