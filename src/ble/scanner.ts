import type { Logging } from "homebridge"
import { MFCT_ID } from "../airthings/const.js"
import { AirthingsClient, UnsupportedDeviceError } from "../airthings/client.js"
import type { AirthingsDevice } from "../airthings/types.js"
import { AirthingsDeviceType, productName } from "../airthings/deviceType.js"
import { withBleAdapterLock } from "./adapterLock.js"
import {
  disposeDevice,
  forgetCachedDevice,
  formatBleAddress,
  manufacturerPayloads,
  normalizeBleAddress,
  openBleBus,
  stopOwnedDiscovery,
  usingDiscovery,
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
  /** delay between advertisement sweeps during discover(); tests may shorten it */
  advertisementIntervalMs?: number
  /** how long a poll waits for BlueZ to expose a device before Device not found */
  deviceDiscoveryTimeoutMs?: number
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

const MODEL_PREFIXES = new Set(
  (Object.values(AirthingsDeviceType) as string[]).filter((value) => /^\d{4}$/.test(value)),
)

/**
 * true when two serials are the same physical airthings device.
 * manufacturer ads use 10 digits (4-digit model + 6-digit unique);
 * the gatt Serial Number characteristic on atom devices is often just the unique part.
 */
export function serialsReferToSameDevice(a: string, b: string): boolean {
  const left = normalizeSerial(a)
  const right = normalizeSerial(b)
  if (!left || !right) {
    return false
  }
  if (left === right) {
    return true
  }
  const [long, short] = left.length >= right.length ? [left, right] : [right, left]
  if (long.length !== 10 || !/^\d{10}$/.test(long) || !long.endsWith(short) || short.length < 4) {
    return false
  }
  return MODEL_PREFIXES.has(long.slice(0, 4))
}

/** prefer the 10-digit manufacturer serial over a short gatt serial */
export function preferSerial(a: string, b: string): string {
  const left = normalizeSerial(a)
  const right = normalizeSerial(b)
  if (!left) return right
  if (!right) return left
  if (left === right) return left
  if (serialsReferToSameDevice(left, right)) {
    return left.length >= right.length ? left : right
  }
  if (/^\d{10}$/.test(left) && !/^\d{10}$/.test(right)) return left
  if (/^\d{10}$/.test(right) && !/^\d{10}$/.test(left)) return right
  return left.length >= right.length ? left : right
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
      const intervalMs = this.config.advertisementIntervalMs ?? 750
      try {
        await usingDiscovery(adapter, async () => {
          const deadline = Date.now() + this.config.scanDurationSec * 1000
          const inspected = new Set<string>()
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
            const remaining = deadline - Date.now()
            if (remaining <= 0 || this.foundAllConfiguredViaAdvertisement()) {
              break
            }
            await sleep(Math.min(intervalMs, remaining))
          }
        })
      } finally {
        // nearby phones and random addresses must not keep a Device1 watch
        this.releaseUnkeptDevices()
        await stopOwnedDiscovery(adapter)
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
    let device: NodeBleDevice
    try {
      device = await this.getCachedDevice(address)
    } catch {
      return
    }

    try {
      await this.inspectAdvertisementDevice(device, address)
    } finally {
      if (!this.shouldKeepDeviceHandle(address)) {
        this.dropBleDevice(address)
      }
    }
  }

  private async inspectAdvertisementDevice(
    device: NodeBleDevice,
    address: string,
  ): Promise<void> {
    const addressConfigured = this.matchesConfiguredAddress(address)

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
    return this.upsertDevice(serial, address, localName, { countAsAdvertisement: true })
  }

  private findDeviceByAddress(address: string): DiscoveredDevice | undefined {
    const addr = normalizeBleAddress(address)
    return [...this.devices.values()].find((d) => normalizeBleAddress(d.address) === addr)
  }

  private configuredSerialFor(serial: string, address: string): string | undefined {
    const addr = normalizeBleAddress(address)
    const incoming = normalizeSerial(serial)
    for (const d of this.config.devices) {
      if (d.serialNumber === undefined) {
        continue
      }
      const configured = normalizeSerial(d.serialNumber)
      if (d.address && normalizeBleAddress(d.address) === addr) {
        return configured
      }
      if (configured === incoming) {
        return configured
      }
    }
    return undefined
  }

  /**
   * one discovered device per ble address.
   * a configured serialNumber is the identity; otherwise prefer the 10-digit mfg serial.
   */
  private upsertDevice(
    serial: string,
    address: string,
    localName: string | null,
    options?: { countAsAdvertisement?: boolean },
  ): DiscoveredDevice {
    const addr = normalizeBleAddress(address)
    const incoming = normalizeSerial(serial)
    const configured = this.configuredSerialFor(incoming, addr)
    const existing = this.findDeviceByAddress(addr)

    let preferred = incoming
    if (configured) {
      preferred = configured
    } else if (existing) {
      preferred = preferSerial(incoming, existing.serialNumber)
    }

    const configuredName = this.config.devices.find(
      (d) =>
        (d.serialNumber !== undefined && normalizeSerial(d.serialNumber) === preferred)
        || (d.address && normalizeBleAddress(d.address) === addr),
    )?.name

    const device: DiscoveredDevice = {
      id: preferred,
      address: addr,
      serialNumber: preferred,
      displayName: configuredName || localName || existing?.displayName || `Airthings ${preferred}`,
    }

    if (existing && existing.id !== preferred) {
      this.log.info(
        `Merging ${existing.serialNumber} into ${preferred} at ${addr}`,
      )
      this.devices.delete(existing.id)
      const prev = this.lastData.get(existing.id)
      this.lastData.delete(existing.id)
      if (prev) {
        this.lastData.set(preferred, prev)
      }
    }

    const isNewAddress = !existing
    this.devices.set(preferred, device)
    this.pendingAddresses.delete(addr)

    if (options?.countAsAdvertisement) {
      this.foundViaAdvertisement.add(preferred)
      this.foundViaAdvertisement.add(incoming)
      if (configured) {
        this.foundViaAdvertisement.add(configured)
      }
    }

    if (isNewAddress && options?.countAsAdvertisement) {
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
    // gatt is more reliable with discovery off. stop our session only;
    // do not start it again when this attempt finishes.
    await stopOwnedDiscovery(adapter)
    try {
      const bleDevice = await this.getBleDevice(addr)
      const data = await this.client.updateDevice(bleDevice)
      const serial = data.identifier
      if (!serial) {
        this.log.warn(`Could not resolve serial for ${addr}; dropping candidate`)
        this.pendingAddresses.delete(normalizeBleAddress(addr))
        return
      }
      const configured = this.configuredSerialFor(serial, addr)
      const resolved = configured ? preferSerial(configured, serial) : serial
      if (!this.matchesFilter(resolved, addr)) {
        this.log.debug(`Resolved ${resolved} at ${addr} but filtered out by config`)
        this.pendingAddresses.delete(normalizeBleAddress(addr))
        return
      }
      const device = this.registerDevice(resolved, addr, data.name ?? null)
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
      // never resume discovery after a connect attempt. a stuck
      // Discovering=yes between polls is what wedges the adapter.
      await stopOwnedDiscovery(adapter)
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
        this.dropBleDevice(address)
      }
    }
    const formatted = formatBleAddress(address)
    const { adapter } = this.requireBus()
    const timeoutMs = this.config.deviceDiscoveryTimeoutMs ?? 30_000
    // always run le discovery while waiting — bluez may not have the Device1 node yet.
    // usingDiscovery stops that session on success and on Device not found.
    return usingDiscovery(adapter, async () => {
      const deadline = Date.now() + timeoutMs
      let lastErr: unknown
      while (Date.now() < deadline) {
        try {
          const device = await adapter.getDevice(formatted)
          this.bleDevices.set(key, device)
          return device
        } catch (err) {
          lastErr = err
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await sleep(Math.min(500, remaining))
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`device ${address} not found during discovery`)
    })
  }

  /** true for devices we will connect to; everyone else is a temporary watch */
  private shouldKeepDeviceHandle(address: string): boolean {
    const addr = normalizeBleAddress(address)
    if (this.pendingAddresses.has(addr)) return true
    if (this.matchesConfiguredAddress(address)) return true
    for (const device of this.devices.values()) {
      if (normalizeBleAddress(device.address) === addr) return true
    }
    return false
  }

  private releaseUnkeptDevices(): void {
    for (const address of [...this.bleDevices.keys()]) {
      if (!this.shouldKeepDeviceHandle(address)) {
        this.dropBleDevice(address)
      }
    }
  }

  /** drop the node-ble Device and the dbus match rules it subscribed */
  private dropBleDevice(address: string): void {
    const key = normalizeBleAddress(address)
    const held = this.bleDevices.get(key)
    this.bleDevices.delete(key)
    const forgotten = this.bus
      ? forgetCachedDevice(this.bus.adapter, address)
      : undefined
    if (held && held !== forgotten) {
      disposeDevice(held)
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
          await stopOwnedDiscovery(this.bus.adapter)
          this.releaseAllDevices()
          this.bus.destroy()
          this.bus = undefined
        }
      }, 5_000)
    } catch (err) {
      this.log.debug(`ble teardown lock skipped: ${String(err)}`)
      this.releaseAllDevices()
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
    const { adapter } = this.requireBus()
    // clear a session we left running. discovery is not resumed after the poll,
    // including when the device is already cached and getBleDevice does not scan.
    await stopOwnedDiscovery(adapter)
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
    } finally {
      await stopOwnedDiscovery(adapter)
    }
  }

  private releaseAllDevices(): void {
    for (const address of [...this.bleDevices.keys()]) {
      this.dropBleDevice(address)
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
    return this.upsertDevice(
      input.serialNumber,
      input.address,
      input.displayName ?? null,
    )
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

