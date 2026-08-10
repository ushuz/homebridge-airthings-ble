import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge"
import type { AirthingsBlePlatform } from "./platform.js"
import {
  BATTERY,
  CO2,
  HUMIDITY,
  ILLUMINANCE,
  LUX,
  PRESSURE,
  RADON_1DAY_AVG,
  RADON_1DAY_LEVEL,
  RADON_LONGTERM_AVG,
  TEMPERATURE,
  VOC,
} from "./airthings/const.js"
import type { AirthingsDevice } from "./airthings/types.js"
import { productName } from "./airthings/deviceType.js"

/**
 * one homekit accessory per airthings device.
 * services are created based on sensors present after the first successful poll.
 */
export class AirthingsPlatformAccessory {
  private temperatureService?: Service
  private humidityService?: Service
  private co2Service?: Service
  private airQualityService?: Service
  private batteryService?: Service
  private lightService?: Service
  private lastDevice?: AirthingsDevice
  private servicesReady = false

  constructor(
    private readonly platform: AirthingsBlePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = accessory.context.device as {
      serialNumber: string
      displayName: string
      address: string
    }

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Airthings")
      .setCharacteristic(this.platform.Characteristic.Model, "Airthings")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.serialNumber || device.address)
      .setCharacteristic(this.platform.Characteristic.Name, device.displayName)

    // restore previously created services so homekit keeps them across restarts
    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
    this.co2Service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor)
    this.airQualityService = this.accessory.getService(this.platform.Service.AirQualitySensor)
    this.batteryService = this.accessory.getService(this.platform.Service.Battery)
    this.lightService = this.accessory.getService(this.platform.Service.LightSensor)

    if (this.airQualityService) {
      this.bindAirQualityHandlers(this.airQualityService)
    }
    if (this.temperatureService) {
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(() => this.num(TEMPERATURE, 0))
    }
    if (this.humidityService) {
      this.humidityService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.num(HUMIDITY, 0))
    }
    if (this.co2Service) {
      this.co2Service
        .getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
        .onGet(() => this.num(CO2, 0))
      this.co2Service
        .getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
        .onGet(() => this.co2Detected())
    }
    if (this.batteryService) {
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .onGet(() => this.num(BATTERY, 100))
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .onGet(() => this.lowBattery())
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.ChargingState)
        .onGet(() => this.platform.Characteristic.ChargingState.NOT_CHARGEABLE)
    }
    if (this.lightService) {
      this.lightService
        .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .onGet(() => this.lightLevel())
    }
  }

  update(device: AirthingsDevice): void {
    this.lastDevice = device
    this.ensureServices(device)

    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)!
    info.setCharacteristic(this.platform.Characteristic.Model, productName(device.model))
    if (device.swVersion) {
      info.setCharacteristic(this.platform.Characteristic.FirmwareRevision, device.swVersion)
    }
    if (device.hwVersion) {
      info.setCharacteristic(this.platform.Characteristic.HardwareRevision, device.hwVersion)
    }
    if (device.manufacturer) {
      info.setCharacteristic(this.platform.Characteristic.Manufacturer, device.manufacturer)
    }
    if (device.identifier) {
      info.setCharacteristic(this.platform.Characteristic.SerialNumber, device.identifier)
    }

    const s = device.sensors

    if (this.temperatureService && s[TEMPERATURE] !== undefined && s[TEMPERATURE] !== null) {
      this.temperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        Number(s[TEMPERATURE]),
      )
    }

    if (this.humidityService && s[HUMIDITY] !== undefined && s[HUMIDITY] !== null) {
      this.humidityService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Number(s[HUMIDITY]),
      )
    }

    if (this.co2Service && s[CO2] !== undefined && s[CO2] !== null) {
      const co2 = Number(s[CO2])
      this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2)
      this.co2Service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideDetected,
        co2 >= 1000
          ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      )
    }

    if (this.batteryService && s[BATTERY] !== undefined && s[BATTERY] !== null) {
      const level = Math.max(0, Math.min(100, Math.round(Number(s[BATTERY]))))
      this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, level)
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        level < 20
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      )
    }

    if (this.lightService) {
      this.lightService.updateCharacteristic(
        this.platform.Characteristic.CurrentAmbientLightLevel,
        this.lightLevel(),
      )
    }

    if (this.airQualityService) {
      this.airQualityService.updateCharacteristic(
        this.platform.Characteristic.AirQuality,
        this.airQualityFromSensors(s),
      )
      if (s[VOC] !== undefined && s[VOC] !== null) {
        try {
          this.airQualityService.updateCharacteristic(
            this.platform.custom.VocDensity,
            Number(s[VOC]),
          )
        } catch {
          // characteristic may not be present on older cached accessories
        }
      }
      if (s[RADON_1DAY_AVG] !== undefined && s[RADON_1DAY_AVG] !== null) {
        try {
          this.airQualityService.updateCharacteristic(
            this.platform.custom.RadonShortTermAverage,
            Number(s[RADON_1DAY_AVG]),
          )
        } catch {
          // ignore
        }
      }
      if (s[RADON_LONGTERM_AVG] !== undefined && s[RADON_LONGTERM_AVG] !== null) {
        try {
          this.airQualityService.updateCharacteristic(
            this.platform.custom.RadonLongTermAverage,
            Number(s[RADON_LONGTERM_AVG]),
          )
        } catch {
          // ignore
        }
      }
      if (s[PRESSURE] !== undefined && s[PRESSURE] !== null) {
        try {
          this.airQualityService.updateCharacteristic(
            this.platform.custom.AirPressure,
            Number(s[PRESSURE]),
          )
        } catch {
          // ignore
        }
      }
    }
  }

  private ensureServices(device: AirthingsDevice): void {
    if (this.servicesReady) {
      // still add newly-seen sensors
    }
    const s = device.sensors
    const name = this.accessory.displayName

    if (s[TEMPERATURE] !== undefined && s[TEMPERATURE] !== null && !this.temperatureService) {
      this.temperatureService = this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        `${name} Temperature`,
        "temperature",
      )
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .setProps({ minValue: -40, maxValue: 100 })
        .onGet(() => this.num(TEMPERATURE, 0))
    }

    if (s[HUMIDITY] !== undefined && s[HUMIDITY] !== null && !this.humidityService) {
      this.humidityService = this.accessory.addService(
        this.platform.Service.HumiditySensor,
        `${name} Humidity`,
        "humidity",
      )
      this.humidityService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.num(HUMIDITY, 0))
    }

    if (s[CO2] !== undefined && s[CO2] !== null && !this.co2Service) {
      this.co2Service = this.accessory.addService(
        this.platform.Service.CarbonDioxideSensor,
        `${name} CO2`,
        "co2",
      )
      this.co2Service
        .getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
        .onGet(() => this.num(CO2, 0))
      this.co2Service
        .getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
        .onGet(() => this.co2Detected())
    }

    if (s[BATTERY] !== undefined && s[BATTERY] !== null && !this.batteryService) {
      this.batteryService = this.accessory.addService(
        this.platform.Service.Battery,
        `${name} Battery`,
        "battery",
      )
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .onGet(() => this.num(BATTERY, 100))
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .onGet(() => this.lowBattery())
      this.batteryService
        .getCharacteristic(this.platform.Characteristic.ChargingState)
        .onGet(() => this.platform.Characteristic.ChargingState.NOT_CHARGEABLE)
    }

    const hasLight = s[ILLUMINANCE] !== undefined || s[LUX] !== undefined
    if (hasLight && !this.lightService) {
      this.lightService = this.accessory.addService(
        this.platform.Service.LightSensor,
        `${name} Light`,
        "light",
      )
      this.lightService
        .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .setProps({ minValue: 0.0001, maxValue: 100000 })
        .onGet(() => this.lightLevel())
    }

    const needsAirQuality =
      s[RADON_1DAY_AVG] !== undefined
      || s[RADON_LONGTERM_AVG] !== undefined
      || s[VOC] !== undefined
      || s[PRESSURE] !== undefined

    if (needsAirQuality && !this.airQualityService) {
      this.airQualityService = this.accessory.addService(
        this.platform.Service.AirQualitySensor,
        `${name} Air Quality`,
        "air-quality",
      )
      this.bindAirQualityHandlers(this.airQualityService)
    }

    this.servicesReady = true
  }

  private bindAirQualityHandlers(service: Service): void {
    service
      .getCharacteristic(this.platform.Characteristic.AirQuality)
      .onGet(() => this.airQualityFromSensors(this.lastDevice?.sensors ?? {}))

    const custom = this.platform.custom as Record<string, any>
    for (const key of ["RadonShortTermAverage", "RadonLongTermAverage", "VocDensity", "AirPressure"]) {
      const ctor = custom[key]
      if (!service.testCharacteristic(ctor)) {
        service.addCharacteristic(ctor)
      }
    }

    service.getCharacteristic(this.platform.custom.RadonShortTermAverage as any)
      .onGet(() => this.num(RADON_1DAY_AVG, 0))
    service.getCharacteristic(this.platform.custom.RadonLongTermAverage as any)
      .onGet(() => this.num(RADON_LONGTERM_AVG, 0))
    service.getCharacteristic(this.platform.custom.VocDensity as any)
      .onGet(() => this.num(VOC, 0))
    service.getCharacteristic(this.platform.custom.AirPressure as any)
      .onGet(() => this.num(PRESSURE, 0))
  }

  private num(key: string, fallback: number): number {
    const v = this.lastDevice?.sensors[key]
    if (v === undefined || v === null) {
      return fallback
    }
    return Number(v)
  }

  private co2Detected(): CharacteristicValue {
    const co2 = this.num(CO2, 0)
    return co2 >= 1000
      ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
      : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
  }

  private lowBattery(): CharacteristicValue {
    const level = this.num(BATTERY, 100)
    return level < 20
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
  }

  private lightLevel(): number {
    const s = this.lastDevice?.sensors ?? {}
    if (s[LUX] !== undefined && s[LUX] !== null) {
      return Math.max(0.0001, Number(s[LUX]))
    }
    if (s[ILLUMINANCE] !== undefined && s[ILLUMINANCE] !== null) {
      // illuminance is 0-100%; map to a nominal lux range homekit accepts
      const pct = Number(s[ILLUMINANCE])
      return Math.max(0.0001, pct * 10)
    }
    return 0.0001
  }

  private airQualityFromSensors(s: Record<string, unknown>): number {
    const AQ = this.platform.Characteristic.AirQuality
    // prefer radon short-term level when present
    const level = s[RADON_1DAY_LEVEL]
    if (level === "good") {
      const radon = Number(s[RADON_1DAY_AVG] ?? 0)
      return radon < 50 ? AQ.EXCELLENT : AQ.GOOD
    }
    if (level === "fair") return AQ.FAIR
    if (level === "poor") return AQ.POOR

    // fall back to co2 / voc heuristics
    const co2 = s[CO2] !== undefined && s[CO2] !== null ? Number(s[CO2]) : null
    const voc = s[VOC] !== undefined && s[VOC] !== null ? Number(s[VOC]) : null
    if (co2 !== null) {
      if (co2 < 600) return AQ.EXCELLENT
      if (co2 < 800) return AQ.GOOD
      if (co2 < 1000) return AQ.FAIR
      if (co2 < 1500) return AQ.INFERIOR
      return AQ.POOR
    }
    if (voc !== null) {
      if (voc < 100) return AQ.EXCELLENT
      if (voc < 250) return AQ.GOOD
      if (voc < 500) return AQ.FAIR
      if (voc < 1000) return AQ.INFERIOR
      return AQ.POOR
    }
    return AQ.UNKNOWN
  }
}
