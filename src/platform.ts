import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge"
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js"
import { BleScanner, type DeviceFilter, type ScannerConfig } from "./ble/scanner.js"
import { AirthingsPlatformAccessory } from "./platformAccessory.js"
import { createCustomCharacteristics, type CustomCharacteristics } from "./customCharacteristics.js"
import type { AirthingsDevice } from "./airthings/types.js"

export interface AirthingsPlatformConfig extends PlatformConfig {
  name?: string
  refreshInterval?: number
  scanDuration?: number
  isMetric?: boolean
  debug?: boolean
  devices?: DeviceFilter[]
}

export class AirthingsBlePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic
  public readonly custom: CustomCharacteristics

  public readonly accessories = new Map<string, PlatformAccessory>()
  private readonly handlers = new Map<string, AirthingsPlatformAccessory>()
  private scanner?: BleScanner

  constructor(
    public readonly log: Logging,
    public readonly config: AirthingsPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.custom = createCustomCharacteristics(api)

    this.log.debug("Finished initializing platform:", this.config.name ?? PLATFORM_NAME)

    this.api.on("didFinishLaunching", () => {
      void this.launch()
    })

    this.api.on("shutdown", () => {
      this.scanner?.stop()
    })
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName)
    this.accessories.set(accessory.UUID, accessory)
  }

  private async launch(): Promise<void> {
    const scannerConfig: ScannerConfig = {
      scanDurationSec: Math.max(5, this.config.scanDuration ?? 20),
      refreshIntervalSec: Math.max(300, this.config.refreshInterval ?? 3600),
      isMetric: this.config.isMetric ?? true,
      debug: this.config.debug ?? false,
      devices: this.config.devices ?? [],
    }

    this.scanner = new BleScanner(this.log, scannerConfig)
    this.scanner.setUpdateHandler((id, device) => this.onDeviceUpdate(id, device))

    try {
      await this.scanner.init()
    } catch (err) {
      this.log.error(`Bluetooth init failed: ${String(err)}`)
      this.log.error(
        "Ensure BlueZ is installed, the adapter is powered on, and the homebridge user is in the bluetooth group.",
      )
      return
    }

    let discovered
    try {
      discovered = await this.scanner.discover()
    } catch (err) {
      this.log.error(`Device discovery failed: ${String(err)}`)
      return
    }

    const seenUuids = new Set<string>()

    for (const device of discovered) {
      const uuid = this.api.hap.uuid.generate(`airthings-ble:${device.serialNumber}`)
      seenUuids.add(uuid)

      const existing = this.accessories.get(uuid)
      if (existing) {
        this.log.info("Restoring accessory:", existing.displayName)
        existing.context.device = {
          serialNumber: device.serialNumber,
          displayName: device.displayName,
          address: device.address,
        }
        this.api.updatePlatformAccessories([existing])
        const handler = new AirthingsPlatformAccessory(this, existing)
        this.handlers.set(device.serialNumber, handler)
      } else {
        this.log.info("Adding accessory:", device.displayName)
        const accessory = new this.api.platformAccessory(device.displayName, uuid)
        accessory.context.device = {
          serialNumber: device.serialNumber,
          displayName: device.displayName,
          address: device.address,
        }
        const handler = new AirthingsPlatformAccessory(this, accessory)
        this.handlers.set(device.serialNumber, handler)
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.set(uuid, accessory)
      }
    }

    // remove cached accessories no longer present (only when not using a fixed device list
    // that might be temporarily offline — still remove unknown ones after a scan)
    for (const [uuid, accessory] of this.accessories) {
      if (!seenUuids.has(uuid)) {
        // keep configured devices that were not seen this scan
        const sn = (accessory.context.device as { serialNumber?: string })?.serialNumber
        const isConfigured = (this.config.devices ?? []).some((d) => d.serialNumber === sn)
        if (isConfigured) {
          this.log.warn("Configured device not seen during scan, keeping:", accessory.displayName)
          if (!this.handlers.has(sn!)) {
            this.handlers.set(sn!, new AirthingsPlatformAccessory(this, accessory))
          }
          continue
        }
        this.log.info("Removing accessory from cache:", accessory.displayName)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.delete(uuid)
      }
    }

    this.scanner.startPolling()
  }

  private onDeviceUpdate(id: string, device: AirthingsDevice): void {
    const handler = this.handlers.get(id)
    if (handler) {
      handler.update(device)
    }
  }
}
