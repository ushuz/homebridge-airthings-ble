import noble, { type Peripheral } from "@abandonware/noble"
import type { Logging } from "homebridge"
import { MFCT_ID, SERVICE_UUIDS } from "../airthings/const.js"
import { AirthingsClient, UnsupportedDeviceError } from "../airthings/client.js"
import type { AirthingsDevice } from "../airthings/types.js"
import { productName } from "../airthings/deviceType.js"

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
}

export interface DiscoveredDevice {
  id: string
  address: string
  serialNumber: string
  displayName: string
  peripheral: Peripheral
}

const POWERED_ON_TIMEOUT_MS = 60_000
const SHUTDOWN_QUEUE_TIMEOUT_MS = 10_000

const SERVICE_UUID_KEYS = new Set(
  SERVICE_UUIDS.map((u) => u.replace(/-/g, "").toLowerCase()),
)

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/-/g, "").replace(/:/g, "")
}

function normalizeServiceUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase()
}

/**
 * parse airthings serial from manufacturer data.
 * payload is company id (uint16 le) + serial (uint32 le), company id may already be stripped on some platforms.
 */
export function parseSerial(manufacturerData?: Buffer): string | null {
  if (!manufacturerData || manufacturerData.length < 4) {
    return null
  }
  try {
    // with company id prefix
    if (manufacturerData.length >= 6) {
      const companyId = manufacturerData.readUInt16LE(0)
      if (companyId === MFCT_ID) {
        return String(manufacturerData.readUInt32LE(2))
      }
    }
    // without company id (some noble backends)
    const maybeCompany = manufacturerData.readUInt16LE(0)
    if (maybeCompany === MFCT_ID && manufacturerData.length >= 6) {
      return String(manufacturerData.readUInt32LE(2))
    }
    // treat entire buffer start as serial when length is 4-5 (payload only)
    if (manufacturerData.length === 4 || manufacturerData.length === 5) {
      return String(manufacturerData.readUInt32LE(0))
    }
  } catch {
    return null
  }
  return null
}

function hasAirthingsServiceUuid(peripheral: Peripheral): boolean {
  const uuids = peripheral.advertisement?.serviceUuids ?? []
  return uuids.some((u) => SERVICE_UUID_KEYS.has(normalizeServiceUuid(u)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * single-adapter ble scanner/poller.
 * serializes connects — important on pi zero w with one hci controller.
 */
export class BleScanner {
  private readonly log: Logging
  private readonly config: ScannerConfig
  private readonly client: AirthingsClient
  private readonly peripherals = new Map<string, Peripheral>()
  private readonly devices = new Map<string, DiscoveredDevice>()
  /** peripherals seen by address before serial is known (service-uuid path) */
  private readonly pendingByAddress = new Map<string, Peripheral>()
  readonly lastData = new Map<string, AirthingsDevice>()
  private queue: Promise<void> = Promise.resolve()
  private refreshTimer: NodeJS.Timeout | null = null
  private stopped = false
  private polling = false
  private state = "unknown"
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

  /** called when a new device is found during a later re-scan */
  setDiscoveredHandler(handler: (device: DiscoveredDevice) => void): void {
    this.onDiscovered = handler
  }

  async init(): Promise<void> {
    await this.waitForPoweredOn()
    this.log.info("Bluetooth adapter ready")
  }

  private waitForPoweredOn(): Promise<void> {
    if (noble.state === "poweredOn") {
      this.state = noble.state
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        noble.removeListener("stateChange", onChange)
        clearTimeout(timer)
      }
      const onChange = (state: string) => {
        this.state = state
        this.log.debug(`Bluetooth state: ${state}`)
        if (settled) return
        if (state === "poweredOn") {
          settled = true
          cleanup()
          resolve()
        } else if (state === "unsupported" || state === "unauthorized") {
          settled = true
          cleanup()
          reject(new Error(`Bluetooth adapter state: ${state}`))
        }
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(
          new Error(
            `Bluetooth adapter did not become poweredOn within ${POWERED_ON_TIMEOUT_MS / 1000}s`
            + ` (last state: ${this.state || noble.state}).`
            + " Enable the adapter, join the bluetooth group, and check setcap on node.",
          ),
        )
      }, POWERED_ON_TIMEOUT_MS)

      noble.on("stateChange", onChange)
      if (noble.state === "poweredOn") {
        onChange(noble.state)
      } else {
        this.state = noble.state
      }
    })
  }

  async discover(options?: { clear?: boolean }): Promise<DiscoveredDevice[]> {
    const clear = options?.clear ?? true
    if (clear) {
      this.devices.clear()
      this.peripherals.clear()
      this.pendingByAddress.clear()
    }

    const onDiscover = (peripheral: Peripheral) => {
      this.handleDiscover(peripheral)
    }

    noble.on("discover", onDiscover)
    try {
      this.log.info(`Scanning for Airthings devices (${this.config.scanDurationSec}s)...`)
      // empty service list + allow duplicates; we filter in handleDiscover
      // (service uuid filter is applied in software so manufacturer-only ads still match)
      await noble.startScanningAsync([], true)
      await sleep(this.config.scanDurationSec * 1000)
      await noble.stopScanningAsync()
    } finally {
      noble.removeListener("discover", onDiscover)
    }

    for (const filter of this.config.devices) {
      if (filter.address) {
        const key = normalizeAddress(filter.address)
        if (![...this.devices.values()].some((d) => normalizeAddress(d.address) === key)) {
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

  private handleDiscover(peripheral: Peripheral): void {
    const serialFromMfg = parseSerial(peripheral.advertisement?.manufacturerData)
    const serviceMatch = hasAirthingsServiceUuid(peripheral)

    if (!serialFromMfg && !serviceMatch) {
      return
    }

    // manufacturer path: full id immediately
    if (serialFromMfg) {
      if (!this.matchesFilter(serialFromMfg, peripheral)) {
        return
      }
      this.registerDevice(serialFromMfg, peripheral)
      return
    }

    // service-uuid only: stash by address; serial resolved on connect during poll
    if (serviceMatch) {
      const address = peripheral.address || peripheral.id
      if (!this.shouldKeepPendingCandidate(peripheral)) {
        return
      }
      this.pendingByAddress.set(normalizeAddress(address), peripheral)
      this.log.debug(
        `Pending Airthings candidate by service uuid: ${address} (serial unknown until connect)`,
      )
    }
  }

  /**
   * whether a service-uuid advertisement (serial unknown) should be kept for later connect.
   * drop only when every filter lists an address and none match — mixed serial/address
   * configs must keep the candidate so serial can be compared after connect.
   */
  private shouldKeepPendingCandidate(peripheral: Peripheral): boolean {
    if (this.config.devices.length === 0) {
      return true
    }
    if (this.matchesFilterByAddress(peripheral)) {
      return true
    }
    // any serial-based entry needs a connect to decide
    const hasSerialEntry = this.config.devices.some((d) => Boolean(d.serialNumber))
    if (hasSerialEntry) {
      return true
    }
    // address-only filters and this address is not among them
    return false
  }

  private registerDevice(serial: string, peripheral: Peripheral): DiscoveredDevice {
    const address = peripheral.address || peripheral.id
    const id = serial
    const isNew = !this.devices.has(id)
    const localName = peripheral.advertisement?.localName
    const configuredName = this.config.devices.find(
      (d) =>
        d.serialNumber === serial
        || (d.address && normalizeAddress(d.address) === normalizeAddress(address)),
    )?.name

    const device: DiscoveredDevice = {
      id,
      address,
      serialNumber: serial,
      displayName: configuredName || localName || `Airthings ${serial}`,
      peripheral,
    }

    this.devices.set(id, device)
    this.peripherals.set(id, peripheral)
    this.pendingByAddress.delete(normalizeAddress(address))

    if (isNew) {
      this.onDiscovered?.(device)
    }
    return device
  }

  private matchesFilter(serial: string, peripheral: Peripheral): boolean {
    if (this.config.devices.length === 0) {
      return true
    }
    const address = normalizeAddress(peripheral.address || peripheral.id)
    return this.config.devices.some((d) => {
      if (d.serialNumber && d.serialNumber === serial) return true
      if (d.address && normalizeAddress(d.address) === address) return true
      return false
    })
  }

  private matchesFilterByAddress(peripheral: Peripheral): boolean {
    if (this.config.devices.length === 0) {
      return true
    }
    const address = normalizeAddress(peripheral.address || peripheral.id)
    return this.config.devices.some(
      (d) => d.address && normalizeAddress(d.address) === address,
    )
  }

  /**
   * @param options.skipInitialRescan when true, first cycle polls without scanning
   *   (use after launch already ran discover)
   */
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

  /** single-flight poll: interval ticks no-op while a cycle is running */
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
      // re-scan so devices that were offline at startup can appear
      if (doRescan) {
        try {
          await this.enqueue(() => this.discover({ clear: false }))
        } catch (err) {
          this.log.warn(`Re-scan failed: ${String(err)}`)
        }
      }

      // try pending service-uuid candidates (serial resolved on connect)
      for (const [addr, peripheral] of [...this.pendingByAddress.entries()]) {
        if (this.stopped) return
        try {
          await this.enqueue(() => this.resolvePending(addr, peripheral))
        } catch (err) {
          this.log.debug(`Failed resolving pending ${addr}: ${String(err)}`)
        }
      }

      for (const device of this.devices.values()) {
        if (this.stopped) return
        try {
          await this.enqueue(() => this.pollDevice(device))
        } catch (err) {
          this.log.error(`Failed to poll ${device.displayName}: ${String(err)}`)
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async resolvePending(addr: string, peripheral: Peripheral): Promise<void> {
    this.log.debug(`Connecting to resolve serial for ${addr}...`)
    try {
      if (peripheral.state === "connected") {
        await peripheral.disconnectAsync()
      }
      const data = await this.client.updateDevice(peripheral)
      const serial = data.identifier
      if (!serial) {
        this.log.warn(`Could not resolve serial for ${addr}; dropping candidate`)
        this.pendingByAddress.delete(addr)
        return
      }
      if (!this.matchesFilter(serial, peripheral)) {
        this.log.debug(`Resolved ${serial} at ${addr} but filtered out by config`)
        this.pendingByAddress.delete(addr)
        return
      }
      const device = this.registerDevice(serial, peripheral)
      this.lastData.set(device.id, data)
      this.onUpdate?.(device.id, data)
    } catch (err) {
      if (err instanceof UnsupportedDeviceError) {
        this.log.warn(`Unsupported pending device ${addr}: ${err.message}`)
        this.pendingByAddress.delete(addr)
        return
      }
      throw err
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    try {
      await noble.stopScanningAsync()
    } catch {
      try {
        noble.stopScanning()
      } catch {
        // ignore
      }
    }

    // wait for in-flight poll work so bluez is not mid-connect on exit
    try {
      await Promise.race([
        this.queue,
        sleep(SHUTDOWN_QUEUE_TIMEOUT_MS),
      ])
    } catch {
      // ignore
    }

    for (const peripheral of this.peripherals.values()) {
      try {
        if (peripheral.state === "connected" || peripheral.state === "connecting") {
          await peripheral.disconnectAsync()
        }
      } catch {
        // ignore
      }
    }
  }

  /** serialize ble operations on the single adapter */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async pollDevice(device: DiscoveredDevice): Promise<AirthingsDevice | null> {
    const peripheral = this.peripherals.get(device.id) ?? device.peripheral
    if (!peripheral) {
      this.log.warn(`No peripheral for ${device.id}`)
      return null
    }

    this.log.debug(`Polling ${device.displayName} (${device.address})...`)
    try {
      if (peripheral.state === "connected") {
        await peripheral.disconnectAsync()
      }
      const data = await this.client.updateDevice(peripheral)
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
      this.log.info(
        `Updated ${data.name} (${productName(data.model)}): ${JSON.stringify(data.sensors)}`,
      )
      return data
    } catch (err) {
      if (err instanceof UnsupportedDeviceError) {
        this.log.warn(`Unsupported device ${device.displayName}: ${err.message}`)
        this.devices.delete(device.id)
        return null
      }
      throw err
    }
  }

  getDiscovered(): DiscoveredDevice[] {
    return [...this.devices.values()]
  }
}
