import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { afterEach, describe, it } from "node:test"
import type { Logging } from "homebridge"
import { MFCT_ID } from "../src/airthings/const.js"
import { bleAdapterLockPath } from "../src/ble/adapterLock.js"
import {
  releaseDbusPropertyWaits,
  usingDiscovery,
  type NodeBleAdapter,
  type NodeBleDevice,
} from "../src/ble/nodeBle.js"
import { BleScanner } from "../src/ble/scanner.js"

const require = createRequire(import.meta.url)
const MessageBus = require("dbus-next/lib/bus") as {
  prototype: {
    _addMatch: (match: string) => Promise<void>
    _removeMatch: (match: string) => Promise<void>
  }
}
const BusHelper = require("node-ble/src/BusHelper") as {
  prototype: {
    removeListeners: () => void
    waitPropChange: (propName: string) => Promise<unknown>
  }
}
const GattCharacteristic = require("node-ble/src/GattCharacteristic") as {
  prototype: { stopNotifications: () => Promise<void> }
}

const HCI = [93, 94, 95]

afterEach(() => {
  for (const id of HCI) {
    rmSync(bleAdapterLockPath(id), { recursive: true, force: true })
  }
})

function mockLog(): Logging {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as Logging
}

describe("dbus match rules are refcounted", () => {
  it("sends AddMatch once and RemoveMatch when the last listener drops", async () => {
    const sent: string[] = []
    const bus = {
      _matchRules: {} as Record<string, number>,
      _connection: { stream: { writable: true } },
      call(msg: { member?: string, body?: string[] }) {
        sent.push(`${msg.member}:${msg.body?.[0]}`)
        return Promise.resolve()
      },
    }
    const rule = "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'"
    await MessageBus.prototype._addMatch.call(bus, rule)
    await MessageBus.prototype._addMatch.call(bus, rule)
    assert.deepEqual(sent, [`AddMatch:${rule}`])
    assert.equal(bus._matchRules[rule], 2)

    await MessageBus.prototype._removeMatch.call(bus, rule)
    assert.equal(sent.length, 1)
    assert.equal(bus._matchRules[rule], 1)

    await MessageBus.prototype._removeMatch.call(bus, rule)
    assert.deepEqual(sent, [`AddMatch:${rule}`, `RemoveMatch:${rule}`])
    assert.equal(Object.hasOwn(bus._matchRules, rule), false)
  })
})

describe("node-ble proxy lifecycle", () => {
  it("does not drop the dbus subscription or rebuild the proxy on removeListeners", () => {
    let proxyCleared = 0
    const helper = {
      _ready: true,
      _objectProxy: { id: 1 },
      _propsProxy: {
        removeAllListeners() {
          proxyCleared += 1
        },
      },
      removeAllListeners() {},
    }
    BusHelper.prototype.removeListeners.call(helper)
    assert.equal(helper._ready, true)
    assert.equal(proxyCleared, 0)
    assert.ok(helper._objectProxy)
  })

  it("removes a ServicesResolved watch when the wait is cancelled", async () => {
    const proxy = new EventEmitter()
    const helper = {
      iface: "org.bluez.Device1",
      _propsProxy: proxy,
      async _prepare() {},
    }
    const pending = BusHelper.prototype.waitPropChange.call(helper, "ServicesResolved")
    // waitPropChange awaits _prepare before subscribing
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(proxy.listenerCount("PropertiesChanged"), 1)
    releaseDbusPropertyWaits()
    assert.equal(proxy.listenerCount("PropertiesChanged"), 0)
    await assert.rejects(pending, /stopped waiting for property change/)
  })

  it("clears notification listeners when StopNotify fails", async () => {
    let cleared = 0
    const characteristic = {
      helper: {
        removeAllListeners() {
          cleared += 1
        },
        async callMethod() {
          throw new Error("stop notifications timed out")
        },
      },
    }
    await assert.rejects(
      () => GattCharacteristic.prototype.stopNotifications.call(characteristic),
      /timed out/,
    )
    assert.ok(cleared >= 1)
  })
})

function controllableAdapter(initialDiscovering = false): {
  adapter: NodeBleAdapter
  events: string[]
  isDiscovering: () => boolean
} {
  let discovering = initialDiscovering
  const events: string[] = []
  const adapter = {
    async isDiscovering() {
      return discovering
    },
    async startDiscovery() {
      events.push("start")
      discovering = true
    },
    async stopDiscovery() {
      events.push("stop")
      discovering = false
    },
    async devices() {
      return []
    },
    async getDevice() {
      throw new Error("Device not found")
    },
  }
  return {
    adapter: adapter as unknown as NodeBleAdapter,
    events,
    isDiscovering: () => discovering,
  }
}

describe("discovery sessions are closed", () => {
  it("stops a session this client started when the body throws", async () => {
    const radio = controllableAdapter(false)
    await assert.rejects(
      () => usingDiscovery(radio.adapter, async () => {
        assert.equal(radio.isDiscovering(), true)
        throw new Error("Device not found")
      }),
      /Device not found/,
    )
    assert.equal(radio.isDiscovering(), false)
    assert.deepEqual(radio.events, ["start", "stop"])
  })

  it("piggybacks when another client owns discovery and does not stop it", async () => {
    const radio = controllableAdapter(true)
    radio.adapter.stopDiscovery = async () => {
      throw new Error("No discovery started")
    }
    const value = await usingDiscovery(radio.adapter, async () => "piggyback")
    assert.equal(value, "piggyback")
    assert.equal(radio.isDiscovering(), true)
    assert.deepEqual(radio.events, [])
  })

  it("stops discovery if start fails after the adapter reported it running", async () => {
    let discovering = false
    const events: string[] = []
    const adapter = {
      async isDiscovering() {
        return discovering
      },
      async startDiscovery() {
        events.push("start")
        discovering = true
        throw new Error("org.bluez.Error.Failed")
      },
      async stopDiscovery() {
        events.push("stop")
        discovering = false
      },
    } as unknown as NodeBleAdapter
    await assert.rejects(() => usingDiscovery(adapter, async () => "nope"), /Failed/)
    assert.equal(discovering, false)
    assert.ok(events.includes("stop"))
  })
})

function trackedDevice(
  address: string,
  manufacturer: Record<string, Buffer> | null,
): { device: NodeBleDevice, disposed: () => number } {
  let disposed = 0
  const device = {
    async getName() {
      return "Wave Enhance"
    },
    async getAddress() {
      return address
    },
    async getManufacturerData() {
      return manufacturer
    },
    helper: {
      removeAllListeners() {},
      _propsProxy: {
        removeAllListeners() {
          disposed += 1
        },
      },
    },
  }
  return {
    device: device as unknown as NodeBleDevice,
    disposed: () => disposed,
  }
}

function serialManufacturer(serial: number): Record<string, Buffer> {
  const payload = Buffer.alloc(4)
  payload.writeUInt32LE(serial >>> 0)
  return { [String(MFCT_ID)]: payload }
}

describe("poll and scan do not leave discovery or device watches behind", () => {
  it("clears a stuck discovery session and does not start another one", async () => {
    const radio = controllableAdapter(true)
    const scanner = new BleScanner(mockLog(), {
      scanDurationSec: 5,
      refreshIntervalSec: 300,
      isMetric: true,
      debug: false,
      devices: [],
      hciDeviceId: HCI[2],
    })
    const internal = scanner as unknown as {
      bus: { adapter: NodeBleAdapter }
      bleDevices: Map<string, NodeBleDevice>
      client: { updateDevice: () => Promise<unknown> }
    }
    internal.bus = { adapter: radio.adapter }
    internal.bleDevices.set("aa:bb:cc:dd:ee:ff", {
      async getAddress() {
        return "AA:BB:CC:DD:EE:FF"
      },
    } as unknown as NodeBleDevice)
    internal.client.updateDevice = async () => {
      throw new Error("Model number was not read")
    }
    scanner.seedKnownDevice({
      serialNumber: "3220001333",
      address: "aa:bb:cc:dd:ee:ff",
      displayName: "Wave Enhance",
    })

    await assert.rejects(
      () => scanner.pollDevice(scanner.getDiscovered()[0]),
      /Model number was not read/,
    )
    assert.equal(radio.isDiscovering(), false)
    assert.deepEqual(radio.events, ["stop"])
  })

  it("stops discovery when the device never appears", async () => {
    const radio = controllableAdapter(false)
    const scanner = new BleScanner(mockLog(), {
      scanDurationSec: 5,
      refreshIntervalSec: 300,
      isMetric: true,
      debug: false,
      devices: [],
      hciDeviceId: HCI[1],
      deviceDiscoveryTimeoutMs: 40,
    })
    const internal = scanner as unknown as {
      bus: { adapter: NodeBleAdapter }
    }
    internal.bus = { adapter: radio.adapter }
    scanner.seedKnownDevice({
      serialNumber: "3220001333",
      address: "b0:d2:78:60:5d:4f",
      displayName: "Wave Enhance",
    })

    await assert.rejects(
      () => scanner.pollDevice(scanner.getDiscovered()[0]),
      /Device not found/,
    )
    assert.equal(radio.isDiscovering(), false)
    assert.equal(radio.events[0], "start")
    assert.equal(radio.events.at(-1), "stop")
    assert.equal(scanner.getDiscovered().length, 1)
  })

  it("drops watches for non-airthings addresses and keeps the wave", async () => {
    const wave = trackedDevice("AA:BB:CC:DD:EE:01", serialManufacturer(2930123456))
    const stranger = trackedDevice("AA:BB:CC:DD:EE:02", null)
    const phone = trackedDevice("AA:BB:CC:DD:EE:03", null)
    const byAddress = new Map<string, NodeBleDevice>([
      ["AA:BB:CC:DD:EE:01", wave.device],
      ["AA:BB:CC:DD:EE:02", stranger.device],
      ["AA:BB:CC:DD:EE:03", phone.device],
    ])
    let discovering = false
    const events: string[] = []
    const adapter = {
      async isDiscovering() {
        return discovering
      },
      async startDiscovery() {
        events.push("start")
        discovering = true
      },
      async stopDiscovery() {
        events.push("stop")
        discovering = false
      },
      async devices() {
        return [...byAddress.keys()]
      },
      async getDevice(address: string) {
        const device = byAddress.get(address.toUpperCase())
        if (!device) throw new Error("Device not found")
        return device
      },
    } as unknown as NodeBleAdapter

    const scanner = new BleScanner(mockLog(), {
      scanDurationSec: 0.05,
      refreshIntervalSec: 300,
      isMetric: true,
      debug: false,
      devices: [],
      hciDeviceId: HCI[0],
      advertisementIntervalMs: 10,
    })
    const internal = scanner as unknown as { bus: { adapter: NodeBleAdapter } }
    internal.bus = { adapter }

    const found = await scanner.discover()
    assert.equal(found.length, 1)
    assert.equal(found[0].serialNumber, "2930123456")
    assert.equal(wave.disposed(), 0)
    assert.ok(stranger.disposed() >= 1)
    assert.ok(phone.disposed() >= 1)
    assert.equal(discovering, false)
    assert.equal(events.at(-1), "stop")

    const handles = (scanner as unknown as { bleDevices: Map<string, unknown> }).bleDevices
    assert.equal(handles.size, 1)
    assert.ok(handles.has("aa:bb:cc:dd:ee:01"))
  })
})
