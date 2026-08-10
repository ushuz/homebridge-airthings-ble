import type { Characteristic, Peripheral, Service } from "@abandonware/noble"
import {
  ATOM_BAT,
  ATOM_CO2,
  ATOM_HUMIDITY,
  ATOM_LUX,
  ATOM_NOISE,
  ATOM_PRESSURE,
  ATOM_RADON_1DAY_AVG,
  ATOM_RADON_MONTH_AVG,
  ATOM_RADON_MONTH_AVG_ALT,
  ATOM_RADON_WEEK_AVG,
  ATOM_RADON_YEAR_AVG,
  ATOM_TEMPERATURE,
  ATOM_VOC,
  BATTERY,
  BQ_TO_PCI_MULTIPLIER,
  CHAR_UUID_DEVICE_NAME,
  CHAR_UUID_FIRMWARE_REV,
  CHAR_UUID_HARDWARE_REV,
  CHAR_UUID_MANUFACTURER_NAME,
  CHAR_UUID_MODEL_NUMBER_STRING,
  CHAR_UUID_SERIAL_NUMBER_STRING,
  CHAR_UUID_WAVE_2_DATA,
  CHAR_UUID_WAVE_PLUS_DATA,
  CHAR_UUID_WAVEMINI_DATA,
  CHAR_UUID_DATETIME,
  CHAR_UUID_HUMIDITY,
  CHAR_UUID_ILLUMINANCE_ACCELEROMETER,
  CHAR_UUID_RADON_1DAYAVG,
  CHAR_UUID_RADON_LONG_TERM_AVG,
  CHAR_UUID_TEMPERATURE,
  CO2,
  COMMAND_TIMEOUT_MS,
  COMMAND_UUID_ATOM,
  COMMAND_UUID_ATOM_NOTIFY,
  COMMAND_UUID_WAVE_2,
  COMMAND_UUID_WAVE_MINI,
  COMMAND_UUID_WAVE_PLUS,
  DATE_TIME,
  DEFAULT_MAX_UPDATE_ATTEMPTS,
  HUMIDITY,
  ILLUMINANCE,
  LUX,
  NOISE,
  PRESSURE,
  RADON_1DAY_AVG,
  RADON_1DAY_LEVEL,
  RADON_LONGTERM_AVG,
  RADON_LONGTERM_LEVEL,
  RADON_MONTH_AVG,
  RADON_MONTH_LEVEL,
  RADON_WEEK_AVG,
  RADON_WEEK_LEVEL,
  RADON_YEAR_AVG,
  RADON_YEAR_LEVEL,
  SensorMap,
  TEMPERATURE,
  UPDATE_TIMEOUT_MS,
  VOC,
} from "./const.js"
import { AtomCommandDecode, getCommandDecoder, type LoggerLike } from "./commandDecode.js"
import { AtomRequestPath } from "./atom/requestPath.js"
import {
  AirthingsDeviceType,
  batteryPercentage,
  deviceTypeFromRaw,
  isAtomDevice,
  productName,
} from "./deviceType.js"
import { getRadonLevel } from "./radonLevel.js"
import { getSensorDecoder } from "./sensorDecoders.js"
import { AirthingsDevice, emptyDevice } from "./types.js"

const SENSOR_CHAR_UUIDS = new Set([
  CHAR_UUID_DATETIME,
  CHAR_UUID_TEMPERATURE,
  CHAR_UUID_HUMIDITY,
  CHAR_UUID_RADON_1DAYAVG,
  CHAR_UUID_RADON_LONG_TERM_AVG,
  CHAR_UUID_ILLUMINANCE_ACCELEROMETER,
  CHAR_UUID_WAVE_PLUS_DATA,
  CHAR_UUID_WAVE_2_DATA,
  CHAR_UUID_WAVEMINI_DATA,
  COMMAND_UUID_WAVE_2,
  COMMAND_UUID_WAVE_PLUS,
  COMMAND_UUID_WAVE_MINI,
].map((u) => u.replace(/-/g, "").toLowerCase()))

function uuidKey(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readChar(char: Characteristic): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    char.read((error, data) => {
      if (error) {
        reject(error)
        return
      }
      resolve(data ?? Buffer.alloc(0))
    })
  })
}

async function writeChar(char: Characteristic, data: Buffer, withoutResponse = false): Promise<void> {
  return new Promise((resolve, reject) => {
    char.write(data, withoutResponse, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function subscribe(char: Characteristic): Promise<void> {
  return new Promise((resolve, reject) => {
    char.subscribe((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function unsubscribe(char: Characteristic): Promise<void> {
  return new Promise((resolve, reject) => {
    char.unsubscribe((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function connectPeripheral(peripheral: Peripheral): Promise<void> {
  if (peripheral.state === "connected") {
    return
  }
  await peripheral.connectAsync()
}

async function disconnectPeripheral(peripheral: Peripheral): Promise<void> {
  if (peripheral.state === "disconnected") {
    return
  }
  try {
    await peripheral.disconnectAsync()
  } catch {
    // ignore disconnect errors
  }
}

export class UnsupportedDeviceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedDeviceError"
  }
}

export interface ClientOptions {
  logger: LoggerLike
  isMetric?: boolean
  maxAttempts?: number
}

/**
 * connect to an airthings peripheral and read sensor data.
 * protocol port of https://github.com/Airthings/airthings-ble
 */
export class AirthingsClient {
  private readonly logger: LoggerLike
  private readonly isMetric: boolean
  private readonly maxAttempts: number

  constructor(options: ClientOptions) {
    this.logger = options.logger
    this.isMetric = options.isMetric ?? true
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_UPDATE_ATTEMPTS
  }

  async updateDevice(peripheral: Peripheral): Promise<AirthingsDevice> {
    const name = peripheral.advertisement?.localName ?? ""
    if (name.includes("Renew") || name.includes("View")) {
      throw new UnsupportedDeviceError(`Model ${name} is not supported`)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await withTimeout(this.updateOnce(peripheral), UPDATE_TIMEOUT_MS, "device update")
      } catch (err) {
        lastError = err
        this.logger.debug(`Update attempt ${attempt + 1} failed: ${String(err)}`)
        await disconnectPeripheral(peripheral)
        if (attempt < this.maxAttempts - 1) {
          await sleep(500)
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async updateOnce(peripheral: Peripheral): Promise<AirthingsDevice> {
    await connectPeripheral(peripheral)
    try {
      const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync()
      const byUuid = new Map<string, Characteristic>()
      for (const char of characteristics) {
        byUuid.set(uuidKey(char.uuid), char)
      }

      const device = emptyDevice({
        address: peripheral.address || peripheral.id,
      })

      await this.readDeviceInfo(byUuid, device)
      if (device.model === AirthingsDeviceType.UNKNOWN) {
        throw new UnsupportedDeviceError("Model is not supported")
      }

      if (isAtomDevice(device.model)) {
        await this.readAtomSensors(byUuid, device)
      } else {
        await this.readWaveSensors(byUuid, device)
      }

      device.lastUpdateAt = Date.now()
      if (!device.name) {
        device.name = `Airthings ${productName(device.model)}`
      }
      return device
    } finally {
      await disconnectPeripheral(peripheral)
    }
  }

  private async readString(byUuid: Map<string, Characteristic>, uuid: string): Promise<string | null> {
    const char = byUuid.get(uuidKey(uuid))
    if (!char) {
      return null
    }
    try {
      const data = await readChar(char)
      return data.toString("utf-8").replace(/\0/g, "").trim()
    } catch (err) {
      this.logger.debug(`Failed reading ${uuid}: ${String(err)}`)
      return null
    }
  }

  private async readDeviceInfo(
    byUuid: Map<string, Characteristic>,
    device: AirthingsDevice,
  ): Promise<void> {
    const modelRaw = await this.readString(byUuid, CHAR_UUID_MODEL_NUMBER_STRING)
    if (modelRaw) {
      device.model = deviceTypeFromRaw(modelRaw)
    }

    const manufacturer = await this.readString(byUuid, CHAR_UUID_MANUFACTURER_NAME)
    if (manufacturer) device.manufacturer = manufacturer

    const serial = await this.readString(byUuid, CHAR_UUID_SERIAL_NUMBER_STRING)
    if (serial && serial !== "Serial Number") {
      device.identifier = serial
    }

    const fw = await this.readString(byUuid, CHAR_UUID_FIRMWARE_REV)
    if (fw) device.swVersion = fw

    const hw = await this.readString(byUuid, CHAR_UUID_HARDWARE_REV)
    if (hw) device.hwVersion = hw

    const name = await this.readString(byUuid, CHAR_UUID_DEVICE_NAME)
    if (name) device.name = name

    // wave gen 1: identifier embedded in device name AT#123456-2900...
    if (
      device.model === AirthingsDeviceType.WAVE_GEN_1
      && device.name
      && !device.identifier
    ) {
      const match = /#([0-9]{6})/.exec(device.name)
      if (match) {
        device.identifier = match[1]
      }
    }
  }

  private async readWaveSensors(
    byUuid: Map<string, Characteristic>,
    device: AirthingsDevice,
  ): Promise<void> {
    const sensors: SensorMap = { ...device.sensors }

    for (const [key, char] of byUuid) {
      if (!SENSOR_CHAR_UUIDS.has(key)) {
        continue
      }

      const decoder = getSensorDecoder(char.uuid)
      if (decoder) {
        try {
          const data = await readChar(char)
          const sensorData = decoder(data)
          delete sensorData[DATE_TIME]
          Object.assign(sensors, sensorData)
          this.applyRadonUnits(sensors, sensorData)
        } catch (err) {
          this.logger.debug(`Failed reading sensor ${char.uuid}: ${String(err)}`)
        }
      }

      const commandDecoder = getCommandDecoder(char.uuid)
      if (commandDecoder) {
        try {
          const batteryData = await this.runCommand(char, commandDecoder)
          if (batteryData?.[BATTERY] !== undefined && batteryData[BATTERY] !== null) {
            sensors[BATTERY] = batteryPercentage(device.model, Number(batteryData[BATTERY]))
          }
          if (batteryData?.[ILLUMINANCE] !== undefined) {
            sensors[ILLUMINANCE] = batteryData[ILLUMINANCE]
          }
        } catch (err) {
          this.logger.debug(`Failed command ${char.uuid}: ${String(err)}`)
        }
      }
    }

    device.sensors = sensors
  }

  private async runCommand(
    char: Characteristic,
    decoder: ReturnType<typeof getCommandDecoder> & object,
  ): Promise<SensorMap | null> {
    if (!decoder) return null
    const receiver = decoder.makeDataReceiver()
    const onData = (data: Buffer) => receiver.asCallback(data)

    char.on("data", onData)
    try {
      await subscribe(char)
      await writeChar(char, decoder.cmd, false)
      try {
        await receiver.waitForMessage(COMMAND_TIMEOUT_MS / 1000)
      } catch {
        this.logger.warn("Timeout getting command data.")
      }
      return decoder.decodeData(this.logger, receiver.message)
    } finally {
      char.removeListener("data", onData)
      try {
        await unsubscribe(char)
      } catch {
        // ignore
      }
    }
  }

  private async readAtomSensors(
    byUuid: Map<string, Characteristic>,
    device: AirthingsDevice,
  ): Promise<void> {
    const writeCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM))
    const notifyCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM_NOTIFY))
    if (!writeCharRef || !notifyCharRef) {
      throw new Error("Missing atom characteristics for device")
    }

    const sensors: SensorMap = { ...device.sensors }

    const connectivity = await this.fetchAtom(writeCharRef, notifyCharRef, AtomRequestPath.CONNECTIVITY_MODE)
    if (connectivity) {
      Object.assign(sensors, connectivity)
    }

    const latest = await this.fetchAtom(writeCharRef, notifyCharRef, AtomRequestPath.LATEST_VALUES)
    if (latest) {
      this.parseAtomSensorData(device.model, sensors, latest)
    }

    device.sensors = sensors
  }

  private async fetchAtom(
    writeCharRef: Characteristic,
    notifyCharRef: Characteristic,
    path: AtomRequestPath,
  ): Promise<SensorMap | null> {
    const decoder = new AtomCommandDecode(path)
    const receiver = decoder.makeDataReceiver()
    // atom responses fit in one notify packet; wait for first packet (size 0 => any data)
    // bump expected size so we wait until first packet arrives, then settle briefly for multi-packet
    const onData = (data: Buffer) => {
      if (receiver.message === null) {
        receiver.message = Buffer.from(data)
      } else {
        receiver.message = Buffer.concat([receiver.message, data])
      }
    }

    notifyCharRef.on("data", onData)
    try {
      await subscribe(notifyCharRef)
      await writeChar(writeCharRef, decoder.cmd, false)
      // wait until we have a response header, then a short settle for multi-packet
      const deadline = Date.now() + COMMAND_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (receiver.message && receiver.message.length >= 9) {
          await sleep(100)
          break
        }
        await sleep(50)
      }
      if (!receiver.message) {
        this.logger.warn("Timeout getting atom command data.")
        return null
      }
      return decoder.decodeData(this.logger, receiver.message)
    } finally {
      notifyCharRef.removeListener("data", onData)
      try {
        await unsubscribe(notifyCharRef)
      } catch {
        // ignore
      }
    }
  }

  private parseAtomSensorData(
    model: AirthingsDeviceType,
    sensors: SensorMap,
    sensorData: SensorMap,
  ): void {
    const next: SensorMap = {}

    if (sensorData[ATOM_BAT] !== undefined && sensorData[ATOM_BAT] !== null) {
      next[BATTERY] = batteryPercentage(model, Number(sensorData[ATOM_BAT]) / 1000.0)
    }
    if (sensorData[ATOM_LUX] !== undefined) next[LUX] = sensorData[ATOM_LUX]
    if (sensorData[ATOM_CO2] !== undefined) next[CO2] = sensorData[ATOM_CO2]
    if (sensorData[ATOM_VOC] !== undefined) next[VOC] = sensorData[ATOM_VOC]
    if (sensorData[ATOM_HUMIDITY] !== undefined) {
      next[HUMIDITY] = Number(sensorData[ATOM_HUMIDITY]) / 100.0
    }
    if (sensorData[ATOM_TEMPERATURE] !== undefined) {
      next[TEMPERATURE] = Math.round((Number(sensorData[ATOM_TEMPERATURE]) / 100.0 - 273.15) * 100) / 100
    }
    if (sensorData[ATOM_NOISE] !== undefined) next[NOISE] = sensorData[ATOM_NOISE]
    if (sensorData[ATOM_PRESSURE] !== undefined) {
      next[PRESSURE] = Number(sensorData[ATOM_PRESSURE]) / (64 * 100)
    }

    this.mapAtomRadon(next, sensorData[ATOM_RADON_1DAY_AVG], RADON_1DAY_AVG, RADON_1DAY_LEVEL)
    this.mapAtomRadon(next, sensorData[ATOM_RADON_WEEK_AVG], RADON_WEEK_AVG, RADON_WEEK_LEVEL)
    const month = sensorData[ATOM_RADON_MONTH_AVG] ?? sensorData[ATOM_RADON_MONTH_AVG_ALT]
    this.mapAtomRadon(next, month, RADON_MONTH_AVG, RADON_MONTH_LEVEL)
    this.mapAtomRadon(next, sensorData[ATOM_RADON_YEAR_AVG], RADON_YEAR_AVG, RADON_YEAR_LEVEL)

    this.logger.debug(`Atom sensor values: ${JSON.stringify(next)}`)
    Object.assign(sensors, next)
  }

  private mapAtomRadon(
    target: SensorMap,
    raw: unknown,
    avgKey: string,
    levelKey: string,
  ): void {
    if (raw === undefined || raw === null) {
      return
    }
    const bq = Number(raw)
    target[avgKey] = this.isMetric ? bq : bq * BQ_TO_PCI_MULTIPLIER
    target[levelKey] = getRadonLevel(bq)
  }

  private applyRadonUnits(sensors: SensorMap, sensorData: SensorMap): void {
    if (sensorData[RADON_1DAY_AVG] !== undefined && sensorData[RADON_1DAY_AVG] !== null) {
      const bq = Number(sensorData[RADON_1DAY_AVG])
      sensors[RADON_1DAY_LEVEL] = getRadonLevel(bq)
      if (!this.isMetric) {
        sensors[RADON_1DAY_AVG] = bq * BQ_TO_PCI_MULTIPLIER
      }
    }
    if (sensorData[RADON_LONGTERM_AVG] !== undefined && sensorData[RADON_LONGTERM_AVG] !== null) {
      const bq = Number(sensorData[RADON_LONGTERM_AVG])
      sensors[RADON_LONGTERM_LEVEL] = getRadonLevel(bq)
      if (!this.isMetric) {
        sensors[RADON_LONGTERM_AVG] = bq * BQ_TO_PCI_MULTIPLIER
      }
    }
  }
}

// re-export service type for typing convenience
export type { Service }
