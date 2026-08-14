import type { Logging } from "homebridge"
import { MFCT_ID } from "../airthings/const.js"
import { AirthingsClient, UnsupportedDeviceError } from "../airthings/client.js"
import type { AirthingsDevice } from "../airthings/types.js"
import { productName } from "../airthings/deviceType.js"
import { withBleAdapterLock } from "./adapterLock.js"
import {
  ensureDiscovery,
  forgetCachedDevice,
  formatBleAddress,
  manufacturerPayloads,
  normalizeBleAddress,
  openBleBus,
  stopDiscoveryIfStarted,
  type BleBus,
  type NodeBleDevice,
} from "./nodeBle.js"

export interface DeviceFilter {
  serialNumber?: string
  address?: string
  name?: string
}

export interface ScannerConfig {
  scanDurationSec: number
  refreshIntervalSec: number
  isMetric: boolean
  debug: boolean
  devices: DeviceFilter[]
  /** bluez adapter index (hci0 = 0); shared lock is per-adapter */
  hciDeviceId?: number
}

export interface DiscoveredDevice {
  id: string
  address: string
  serialNumber: string
  displayName: string
}

const SHUTDOWN_QUEUE_TIMEOUT_MS = 10_000
const LOCK_OWNER = "airthings-ble"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * parse airthings serial from manufacturer data.
 * payload is company id (uint16 le) + serial (uint32 le).
 */
export function parseSerial(
  manufacturerData?: Buffer,
  options?: { allowStrippedPayload?: boolean },
): string | null {
  if (!manufacturerData || manufacturerData.length < 4) {
    return null
  }
  try {
    if (manufacturerData.length >= 6) {
      const companyId = manufacturerData.readUInt16LE(0)
      if (companyId === MFCT_ID) {
        return String(manufacturerData.readUInt32LE(2))
      }
      return null
    }
    if (
      options?.allowStrippedPayload
      && (manufacturerData.length === 4 || manufacturerData.length === 5)
    ) {
      return String(manufacturerData.readUInt32LE(0))
    }
  } catch {
    return null
  }
  return null
}

export function normalizeSerial(value: unknown): string {
  return String(value ?? "").trim()
}

/**
 * bluez/dbus ble scanner/poller via node-ble.
 * cross-plugin adapter lock coordinates with govee-ble (same protocol).
 */
export class BleScanner {
  private readonly log: Logging
  private readonly config: ScannerConfig
  private readonly client: AirthingsClient
  private readonly devices = new Map<string, DiscoveredDevice>()
  /** serials found via advertisement during the current discover() call */
  private readonly foundViaAdvertisement = new Set<string>()
  /** addresses seen via service-uuid path before serial is known */
  private readonly pendingAddresses = new Set<string>()
  readonly lastData = new Map<string, AirthingsDevice>()
  private queue: Promise<void> = Promise.resolve()
  private refreshTimer: NodeJS.Timeout | null = null
  private stopped = false
  private polling = false
  private bus?: BleBus
  /** reuse node-ble Device proxies to avoid stacking PropertiesChanged listeners */
  private readonly bleDevices = new Map<string, NodeBleDevice>()
  private onUpdate?: (id: string, device: AirthingsDevice) => void
  private onDiscovered?: (device: DiscoveredDevice) => void

  constructor(log: Logging, config: ScannerConfig) {
    this.log = log
    this.config = config
    this.client = new AirthingsClient({
      logger: {
        debug: (msg, ...args) => {
          if (this.config.debug) {
            this.log.debug(msg, ...args)
          }
        },
        warn: (msg, ...args) => this.log.warn(msg, ...args),
        error: (msg, ...args) => this.log.error(msg, ...args),
      },
      isMetric: config.isMetric,
    })
  }

  setUpdateHandler(handler: (id: string, device: AirthingsDevice) => void): void {
    this.onUpdate = handler
  }

  setDiscoveredHandler(handler: (device: DiscoveredDevice) => void): void {
    this.onDiscovered = handler
  }

  private withAdapterLock<T>(
    fn: () => Promise<T>,
    acquireTimeoutMs?: number,
  ): Promise<T> {
    const scanMs = this.config.scanDurationSec * 1000
    const timeout = acquireTimeoutMs ?? Math.max(120_000, scanMs + 60_000)
    return withBleAdapterLock(
      {
        owner: LOCK_OWNER,
        hciDeviceId: this.config.hciDeviceId ?? 0,
        acquireTimeoutMs: timeout,
        log: {
          debug: (msg, ...args) => this.log.debug(msg, ...args),
          info: (msg, ...args) => this.log.info(msg, ...args),
          warn: (msg, ...args) => this.log.warn(msg, ...args),
        },
      },
      fn,
    )
  }

  async init(): Promise<void> {
    await this.withAdapterLock(async () => {
      this.bus = await openBleBus(this.config.hciDeviceId ?? 0)
      const addr = await this.bus.adapter.getAddress().catch(() => "?")
      this.log.info(
        `Bluetooth adapter ready (${this.bus.adapterName} ${addr}) via node-ble/bluez`,
      )
    })
  }

  private requireBus(): BleBus {
    if (!this.bus) {
      throw new Error("bluetooth bus not initialized")
    }
    return this.bus
  }

  async discover(options?: { clear?: boolean }): Promise<DiscoveredDevice[]> {
    const clear = options?.clear ?? true
    if (clear) {
      this.devices.clear()
      this.pendingAddresses.clear()
    }
    this.foundViaAdvertisement.clear()

    const { adapter } = this.requireBus()
    this.log.info(`Scanning for Airthings devices (${this.config.scanDurationSec}s)...`)

    // inspect while discovery is active — bluez often clears ManufacturerData
    // after StopDiscovery. only walk each bluez address once (plus known targets
    // every second) so the shared lock is not held for minutes on pi zero.
    const knownTargets = new Set<string>()
    for (const d of this.config.devices) {
      if (d.address) knownTargets.add(normalizeBleAddress(d.address))
    }
    for (const d of this.devices.values()) {
      knownTargets.add(normalizeBleAddress(d.address))
    }

    await this.withAdapterLock(async () => {
      const startedHere = await ensureDiscovery(adapter)
      const inspected = new Set<string>()
      try {
        const deadline = Date.now() + this.config.scanDurationSec * 1000
        while (Date.now() < deadline) {
          if (this.foundAllConfiguredViaAdvertisement()) {
            break
          }
          let addresses: string[] = []
          try {
            addresses = await adapter.devices()
          } catch {
            addresses = []
          }
          const fresh = addresses.filter((a) => !inspected.has(normalizeBleAddress(a)))
          for (const a of fresh) {
            inspected.add(normalizeBleAddress(a))
          }
          // re-check known targets every loop (mfg may appear late)
          const batch = [
            ...fresh,
            ...[...knownTargets].filter((a) => !fresh.some((f) => normalizeBleAddress(f) === a)),
          ]
          await mapPool(batch.slice(0, 24), 8, async (address) => {
            await this.inspectAdvertisement(address)
          })
          await sleep(750)
        }
      } finally {
        await stopDiscoveryIfStarted(adapter, startedHere)
      }
    })

    for (const filter of this.config.devices) {
      if (filter.address) {
        const key = normalizeBleAddress(filter.address)
        if (![...this.devices.values()].some((d) => normalizeBleAddress(d.address) === key)) {
          this.log.warn(
            `Configured address ${filter.address} not seen during scan;`
            + " will retry on later re-scans.",
          )
        }
      }
    }

    const list = [...this.devices.values()]
    this.log.info(`Discovered ${list.length} Airthings device(s)`)
    for (const d of list) {
      this.log.info(`  - ${d.displayName} sn=${d.serialNumber} address=${d.address}`)
    }
    return list
  }

  private async getCachedDevice(address: string): Promise<NodeBleDevice> {
    const key = normalizeBleAddress(address)
    const cached = this.bleDevices.get(key)
    if (cached) {
      return cached
    }
    const { adapter } = this.requireBus()
    const device = await adapter.getDevice(formatBleAddress(address))
    this.bleDevices.set(key, device)
    return device
  }

  private async inspectAdvertisement(address: string): Promise<void> {
    const addressConfigured = this.matchesConfiguredAddress(address)

    let device: NodeBleDevice
    try {
      device = await this.getCachedDevice(address)
    } catch {
      return
    }

    let mfg: Record<string, unknown> | null = null
    try {
      mfg = await device.getManufacturerData()
    } catch {
      mfg = null
    }

    // most bluez cache entries have no manufacturer data — skip fast
    const payloads = manufacturerPayloads(mfg)
    if (payloads.length === 0 && !addressConfigured) {
      return
    }

    let serial: string | null = null
    for (const payload of payloads) {
      serial = parseSerial(payload)
      if (serial) break
      if (addressConfigured) {
        serial = parseSerial(payload, { allowStrippedPayload: true })
        if (serial) break
      }
      // stripped only if parsed serial matches a configured serial
      if (this.config.devices.some((d) => d.serialNumber !== undefined)) {
        const stripped = parseSerial(payload, { allowStrippedPayload: true })
        if (
          stripped
          && this.config.devices.some(
            (d) =>
              d.serialNumber !== undefined
              && normalizeSerial(d.serialNumber) === normalizeSerial(stripped),
          )
        ) {
          serial = stripped
          break
        }
      }
    }

    // also accept company id key 820 even if only payload present
    if (!serial && mfg) {
      const raw = mfg[String(MFCT_ID)] ?? mfg[MFCT_ID]
      if (raw) {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from((raw as { data?: number[] }).data ?? [])
        if (buf.length >= 4) {
          try {
            serial = String(buf.readUInt32LE(0))
          } catch {
            // ignore
          }
        }
      }
    }

    if (serial) {
      if (!this.matchesFilter(serial, address)) {
        return
      }
      const localName = await device.getName().catch(() => null)
      this.registerDevice(serial, address, localName)
      return
    }

    // without mfg serial, only keep explicitly configured addresses as pending.
    // do not connect to every bluez device when serial filters are present —
    // that would hammer unrelated peripherals on a dense network.
    if (this.matchesConfiguredAddress(address)) {
      this.pendingAddresses.add(normalizeBleAddress(address))
      this.log.debug(`Pending Airthings candidate: ${address} (serial unknown until connect)`)
    }
  }

  private registerDevice(
    serial: string,
    address: string,
    localName: string | null,
  ): DiscoveredDevice {
    const id = serial
    const isNew = !this.devices.has(id)
    const configuredName = this.config.devices.find(
      (d) =>
        (d.serialNumber !== undefined && normalizeSerial(d.serialNumber) === normalizeSerial(serial))
        || (d.address && normalizeBleAddress(d.address) === normalizeBleAddress(address)),
    )?.name

    const device: DiscoveredDevice = {
      id,
      address: normalizeBleAddress(address),
      serialNumber: serial,
      displayName: configuredName || localName || `Airthings ${serial}`,
    }

    this.devices.set(id, device)
    this.pendingAddresses.delete(normalizeBleAddress(address))
    this.foundViaAdvertisement.add(normalizeSerial(serial))

    if (isNew) {
      this.onDiscovered?.(device)
    }
    return device
  }

  private matchesFilter(serial: string, address: string): boolean {
    if (this.config.devices.length === 0) {
      return true
    }
    const addr = normalizeBleAddress(address)
    const serialKey = normalizeSerial(serial)
    return this.config.devices.some((d) => {
      if (d.serialNumber !== undefined && normalizeSerial(d.serialNumber) === serialKey) {
        return true
      }
      if (d.address && normalizeBleAddress(d.address) === addr) return true
      return false
    })
  }

  private matchesConfiguredAddress(address: string): boolean {
    if (this.config.devices.length === 0) {
      return false
    }
    const addr = normalizeBleAddress(address)
    return this.config.devices.some(
      (d) => d.address && normalizeBleAddress(d.address) === addr,
    )
  }

  /**
   * true when every configured serial has been seen in ads this scan.
   * ignores seedKnownDevice entries so we do not abort the radio scan early.
   */
  private foundAllConfiguredViaAdvertisement(): boolean {
    if (this.config.devices.length === 0) {
      return this.foundViaAdvertisement.size > 0
    }
    return this.config.devices.every((filter) => {
      if (filter.serialNumber !== undefined) {
        return this.foundViaAdvertisement.has(normalizeSerial(filter.serialNumber))
      }
      if (filter.address) {
        const key = normalizeBleAddress(filter.address)
        return [...this.devices.values()].some(
          (d) =>
            normalizeBleAddress(d.address) === key
            && this.foundViaAdvertisement.has(normalizeSerial(d.serialNumber)),
        )
      }
      return true
    })
  }

  startPolling(options?: { skipInitialRescan?: boolean }): void {
    this.stopped = false
    this.skipNextRescan = options?.skipInitialRescan ?? false
    void this.pollCycle()
    this.refreshTimer = setInterval(() => {
      void this.pollCycle()
    }, this.config.refreshIntervalSec * 1000)
    this.refreshTimer.unref?.()
  }

  private skipNextRescan = false

  private async pollCycle(): Promise<void> {
    if (this.stopped || this.polling) {
      if (this.polling) {
        this.log.debug("Skipping poll cycle; previous cycle still running")
      }
      return
    }
    this.polling = true
    try {
      const doRescan = !this.skipNextRescan
      this.skipNextRescan = false
      if (doRescan) {
        try {
          await this.enqueue(() => this.discover({ clear: false }))
        } catch (err) {
          this.log.warn(`Re-scan failed: ${String(err)}`)
        }
      }

      for (const addr of [...this.pendingAddresses]) {
        if (this.stopped) return
        try {
          await this.enqueue(() => this.resolvePending(addr))
        } catch (err) {
          this.log.debug(`Failed resolving pending ${addr}: ${String(err)}`)
        }
      }

      const devices = [...this.devices.values()]
      this.log.info(`[sync] poll cycle: ${devices.length} device(s)`)
      for (const device of devices) {
        if (this.stopped) return
        try {
          await this.enqueue(() => this.pollDevice(device))
        } catch {
          // already logged
        }
      }
      this.log.info("[sync] poll cycle complete")
    } finally {
      this.polling = false
    }
  }

  private async resolvePending(addr: string): Promise<void> {
    return this.withAdapterLock(() => this.resolvePendingLocked(addr))
  }

  private async resolvePendingLocked(addr: string): Promise<void> {
    this.log.debug(`Connecting to resolve serial for ${addr}...`)
    const { adapter } = this.requireBus()
    // prefer discovery stopped before gatt connect
    const wasDiscovering = await adapter.isDiscovering()
    if (wasDiscovering) {
      try { await adapter.stopDiscovery() } catch { /* ignore */ }
    }
    try {
      const bleDevice = await this.getBleDevice(addr)
      const data = await this.client.updateDevice(bleDevice)
      const serial = data.identifier
      if (!serial) {
        this.log.warn(`Could not resolve serial for ${addr}; dropping candidate`)
        this.pendingAddresses.delete(normalizeBleAddress(addr))
        return
      }
      if (!this.matchesFilter(serial, addr)) {
        this.log.debug(`Resolved ${serial} at ${addr} but filtered out by config`)
        this.pendingAddresses.delete(normalizeBleAddress(addr))
        return
      }
      const device = this.registerDevice(serial, addr, data.name ?? null)
      this.lastData.set(device.id, data)
      this.onUpdate?.(device.id, data)
    } catch (err) {
      if (err instanceof UnsupportedDeviceError) {
        this.log.warn(`Unsupported pending device ${addr}: ${err.message}`)
        this.pendingAddresses.delete(normalizeBleAddress(addr))
        return
      }
      throw err
    } finally {
      if (wasDiscovering) {
        try {
          if (!(await adapter.isDiscovering())) {
            await adapter.startDiscovery()
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private async getBleDevice(address: string): Promise<NodeBleDevice> {
    const key = normalizeBleAddress(address)
    const cached = this.bleDevices.get(key)
    if (cached) {
      try {
        await cached.getAddress()
        return cached
      } catch {
        this.bleDevices.delete(key)
        forgetCachedDevice(this.requireBus().adapter, address)
      }
    }
    const formatted = formatBleAddress(address)
    const { adapter } = this.requireBus()
    // always run le discovery while waiting — bluez may not have the Device1 node yet
    const started = await ensureDiscovery(adapter)
    try {
      const deadline = Date.now() + 30_000
      let lastErr: unknown
      while (Date.now() < deadline) {
        try {
          const device = await adapter.getDevice(formatted)
          this.bleDevices.set(key, device)
          return device
        } catch (err) {
          lastErr = err
          await sleep(500)
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`device ${address} not found during discovery`)
    } finally {
      await stopDiscoveryIfStarted(adapter, started)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }

    try {
      await Promise.race([
        this.queue,
        sleep(SHUTDOWN_QUEUE_TIMEOUT_MS),
      ])
    } catch {
      // ignore
    }

    try {
      await this.withAdapterLock(async () => {
        if (this.bus) {
          try {
            if (await this.bus.adapter.isDiscovering()) {
              await this.bus.adapter.stopDiscovery()
            }
          } catch {
            // ignore
          }
          this.bleDevices.clear()
          this.bus.destroy()
          this.bus = undefined
        }
      }, 5_000)
    } catch (err) {
      this.log.debug(`ble teardown lock skipped: ${String(err)}`)
      this.bleDevices.clear()
      try {
        this.bus?.destroy()
      } catch {
        // ignore
      }
      this.bus = undefined
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async pollDevice(device: DiscoveredDevice): Promise<AirthingsDevice | null> {
    return this.withAdapterLock(() => this.pollDeviceLocked(device))
  }

  private async pollDeviceLocked(device: DiscoveredDevice): Promise<AirthingsDevice | null> {
    const started = Date.now()
    this.log.info(
      `[sync] ${device.displayName} sn=${device.serialNumber}: starting`
      + ` (address=${device.address || "unknown"})`,
    )
    try {
      const { adapter } = this.requireBus()
      const wasDiscovering = await adapter.isDiscovering()
      if (wasDiscovering) {
        try { await adapter.stopDiscovery() } catch { /* ignore */ }
      }
      try {
        const bleDevice = await this.getBleDevice(device.address)
        const data = await this.client.updateDevice(bleDevice, device.displayName)
        if (!data.identifier) {
          data.identifier = device.serialNumber
        }
        if (data.name) {
          device.displayName = device.displayName.startsWith("Airthings ")
            ? data.name
            : device.displayName
        } else {
          data.name = device.displayName
        }
        if (!data.name || data.name === device.serialNumber) {
          data.name = `Airthings ${productName(data.model)}`
        }

        this.lastData.set(device.id, data)
        this.onUpdate?.(device.id, data)
        const ms = Date.now() - started
        this.log.info(
          `[sync] ${device.displayName} sn=${device.serialNumber}: ok in ${ms}ms`
          + ` model=${productName(data.model)} sensors=${JSON.stringify(data.sensors)}`,
        )
        return data
      } finally {
        if (wasDiscovering) {
          try {
            if (!(await adapter.isDiscovering())) {
              await adapter.startDiscovery()
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      const ms = Date.now() - started
      if (err instanceof UnsupportedDeviceError) {
        this.log.warn(
          `[sync] ${device.displayName} sn=${device.serialNumber}: unsupported after ${ms}ms`
          + ` — ${err.message}`,
        )
        this.devices.delete(device.id)
        return null
      }
      this.log.error(
        `[sync] ${device.displayName} sn=${device.serialNumber}: failed after ${ms}ms`
        + ` — ${String(err)}`,
      )
      throw err
    }
  }

  getDiscovered(): DiscoveredDevice[] {
    return [...this.devices.values()]
  }

  /**
   * re-register a device known from homebridge cache / prior discovery.
   * used when a scan misses manufacturer ads so poll can still connect by address.
   */
  seedKnownDevice(input: {
    serialNumber: string
    address: string
    displayName?: string
  }): DiscoveredDevice {
    // register without counting as advertisement-found
    const serial = normalizeSerial(input.serialNumber)
    const address = normalizeBleAddress(input.address)
    const id = serial
    const device: DiscoveredDevice = {
      id,
      address,
      serialNumber: serial,
      displayName: input.displayName || `Airthings ${serial}`,
    }
    this.devices.set(id, device)
    return device
  }
}

/** run async work over items with a concurrency limit */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return
  }
  const limit = Math.max(1, concurrency)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      await worker(items[i])
    }
  })
  await Promise.all(runners)
}

