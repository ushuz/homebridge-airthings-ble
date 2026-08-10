import noble, { type Peripheral } from "@abandonware/noble"
import type { Logging } from "homebridge"
import { MFCT_ID } from "../airthings/const.js"
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

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/-/g, "").replace(/:/g, "")
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
    // if first two bytes look like company id elsewhere, skip
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
  readonly lastData = new Map<string, AirthingsDevice>()
  private queue: Promise<void> = Promise.resolve()
  private refreshTimer: NodeJS.Timeout | null = null
  private stopped = false
  private state = "unknown"
  private onUpdate?: (id: string, device: AirthingsDevice) => void

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
      const onChange = (state: string) => {
        this.state = state
        this.log.debug(`Bluetooth state: ${state}`)
        if (state === "poweredOn") {
          noble.removeListener("stateChange", onChange)
          resolve()
        } else if (state === "unsupported" || state === "unauthorized") {
          noble.removeListener("stateChange", onChange)
          reject(new Error(`Bluetooth adapter state: ${state}`))
        }
      }
      noble.on("stateChange", onChange)
      // handle already-set state races
      if (noble.state === "poweredOn") {
        onChange(noble.state)
      }
    })
  }

  async discover(): Promise<DiscoveredDevice[]> {
    this.devices.clear()
    this.peripherals.clear()

    const onDiscover = (peripheral: Peripheral) => {
      this.handleDiscover(peripheral)
    }

    noble.on("discover", onDiscover)
    try {
      this.log.info(`Scanning for Airthings devices (${this.config.scanDurationSec}s)...`)
      await noble.startScanningAsync([], true)
      await sleep(this.config.scanDurationSec * 1000)
      await noble.stopScanningAsync()
    } finally {
      noble.removeListener("discover", onDiscover)
    }

    // also include configured addresses not seen in scan (direct connect later)
    for (const filter of this.config.devices) {
      if (filter.address) {
        const key = normalizeAddress(filter.address)
        if (![...this.devices.values()].some((d) => normalizeAddress(d.address) === key)) {
          this.log.warn(
            `Configured address ${filter.address} not seen during scan; it will be skipped until advertised`,
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
    const serial = parseSerial(peripheral.advertisement?.manufacturerData)
    if (!serial) {
      return
    }

    if (!this.matchesFilter(serial, peripheral)) {
      return
    }

    const address = peripheral.address || peripheral.id
    const id = serial
    const localName = peripheral.advertisement?.localName
    const configuredName = this.config.devices.find(
      (d) => d.serialNumber === serial || (d.address && normalizeAddress(d.address) === normalizeAddress(address)),
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

  startPolling(): void {
    this.stopped = false
    void this.pollAll()
    this.refreshTimer = setInterval(() => {
      void this.pollAll()
    }, this.config.refreshIntervalSec * 1000)
    // unref so homebridge can exit cleanly in tests
    this.refreshTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    try {
      noble.stopScanning()
    } catch {
      // ignore
    }
  }

  private async pollAll(): Promise<void> {
    if (this.stopped) return
    for (const device of this.devices.values()) {
      if (this.stopped) return
      try {
        await this.enqueue(() => this.pollDevice(device))
      } catch (err) {
        this.log.error(`Failed to poll ${device.displayName}: ${String(err)}`)
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
      // ensure disconnected before connect
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
      // prefer friendly product name when local name is generic
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
