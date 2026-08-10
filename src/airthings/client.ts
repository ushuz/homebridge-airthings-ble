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
import {
  formatVersion,
  needsFirmwareUpgrade,
  parseFirmwareVersion,
  requiredFirmwareForModel,
} from "./firmware.js"
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

/** settle window after last atom notify packet before treating payload as complete */
const ATOM_NOTIFY_SETTLE_MS = 150

function uuidKey(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  /** generation counter so timed-out attempts ignore late results */
  private updateGeneration = 0

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
      const generation = ++this.updateGeneration
      try {
        return await this.updateOnceWithTimeout(peripheral, generation)
      } catch (err) {
        lastError = err
        this.logger.debug(`Update attempt ${attempt + 1} failed: ${String(err)}`)
        // force disconnect and wait so the timed-out attempt finishes cleanup
        // before the next connect (single hci adapter on pi zero w)
        await disconnectPeripheral(peripheral)
        await sleep(300)
        if (attempt < this.maxAttempts - 1) {
          await sleep(200)
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * run updateOnce with a wall-clock timeout.
   * on timeout: invalidate generation, disconnect, and await the in-flight work
   * so its finally cannot run against a newer retry's connection.
   */
  private async updateOnceWithTimeout(
    peripheral: Peripheral,
    generation: number,
  ): Promise<AirthingsDevice> {
    let timer: NodeJS.Timeout | undefined
    let timedOut = false

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`device update timed out after ${UPDATE_TIMEOUT_MS}ms`))
      }, UPDATE_TIMEOUT_MS)
    })

    const work = this.updateOnce(peripheral, generation)

    try {
      return await Promise.race([work, timeoutPromise])
    } catch (err) {
      if (timedOut) {
        // drop ownership so updateOnce finally will not disconnect a later attempt
        if (this.updateGeneration === generation) {
          this.updateGeneration++
        }
        await disconnectPeripheral(peripheral)
        // wait for the timed-out work to finish its stack (no shared disconnect race)
        await work.then(
          () => undefined,
          () => undefined,
        )
        await sleep(200)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async updateOnce(
    peripheral: Peripheral,
    generation: number,
  ): Promise<AirthingsDevice> {
    this.assertGeneration(generation)
    await connectPeripheral(peripheral)
    this.assertGeneration(generation)
    try {
      const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync()
      this.assertGeneration(generation)
      const byUuid = new Map<string, Characteristic>()
      for (const char of characteristics) {
        byUuid.set(uuidKey(char.uuid), char)
      }

      const device = emptyDevice({
        address: peripheral.address || peripheral.id,
      })

      await this.readDeviceInfo(byUuid, device)
      this.assertGeneration(generation)
      if (device.model === AirthingsDeviceType.UNKNOWN) {
        throw new UnsupportedDeviceError("Model is not supported")
      }

      if (isAtomDevice(device.model)) {
        this.warnIfFirmwareOutdated(device)
        await this.readAtomSensors(byUuid, device, generation)
      } else {
        await this.readWaveSensors(byUuid, device, generation)
      }

      this.assertGeneration(generation)
      device.lastUpdateAt = Date.now()
      if (!device.name) {
        device.name = `Airthings ${productName(device.model)}`
      }
      return device
    } finally {
      // only the live generation may tear down the connection.
      // a timed-out attempt that lost ownership must not disconnect a newer retry.
      if (this.updateGeneration === generation) {
        await disconnectPeripheral(peripheral)
      }
    }
  }

  private assertGeneration(generation: number): void {
    if (this.updateGeneration !== generation) {
      throw new Error("stale device update attempt")
    }
  }

  private warnIfFirmwareOutdated(device: AirthingsDevice): void {
    const required = requiredFirmwareForModel(device.model)
    if (!required) {
      return
    }
    if (needsFirmwareUpgrade(device.swVersion, required)) {
      const current = parseFirmwareVersion(device.swVersion)
      this.logger.warn(
        `Firmware for ${device.address} is not up to date`
        + ` (current ${current ? formatVersion(current) : device.swVersion || "unknown"},`
        + ` need ${required} or newer). Update via the Airthings app.`,
      )
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
    generation: number,
  ): Promise<void> {
    const sensors: SensorMap = { ...device.sensors }

    for (const [key, char] of byUuid) {
      this.assertGeneration(generation)
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
    decoder: NonNullable<ReturnType<typeof getCommandDecoder>>,
  ): Promise<SensorMap | null> {
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
    generation: number,
  ): Promise<void> {
    const writeCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM))
    const notifyCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM_NOTIFY))
    if (!writeCharRef || !notifyCharRef) {
      throw new Error("Missing atom characteristics for device")
    }

    const sensors: SensorMap = { ...device.sensors }

    this.assertGeneration(generation)
    const connectivity = await this.fetchAtom(writeCharRef, notifyCharRef, AtomRequestPath.CONNECTIVITY_MODE)
    if (connectivity) {
      Object.assign(sensors, connectivity)
    }

    this.assertGeneration(generation)
    const latest = await this.fetchAtom(writeCharRef, notifyCharRef, AtomRequestPath.LATEST_VALUES)
    if (latest) {
      this.parseAtomSensorData(device.model, sensors, latest)
    }

    device.sensors = sensors
  }

  /**
   * collect atom notify payload until silence after the header arrives,
   * or total timeout. more reliable than a single 100ms settle for multi-packet cbor.
   */
  private async fetchAtom(
    writeCharRef: Characteristic,
    notifyCharRef: Characteristic,
    path: AtomRequestPath,
  ): Promise<SensorMap | null> {
    const decoder = new AtomCommandDecode(path)
    // object holder so closure mutations stay visible to the control flow
    const state: { message: Buffer | null, lastPacketAt: number } = {
      message: null,
      lastPacketAt: 0,
    }

    const onData = (data: Buffer) => {
      state.lastPacketAt = Date.now()
      if (state.message === null) {
        state.message = Buffer.from(data)
      } else {
        state.message = Buffer.concat([state.message, data])
      }
    }

    notifyCharRef.on("data", onData)
    try {
      await subscribe(notifyCharRef)
      await writeChar(writeCharRef, decoder.cmd, false)

      const deadline = Date.now() + COMMAND_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (state.message && state.message.length >= 9) {
          // wait until no new packets for settle window
          if (Date.now() - state.lastPacketAt >= ATOM_NOTIFY_SETTLE_MS) {
            break
          }
        }
        await sleep(40)
      }

      if (!state.message) {
        this.logger.warn("Timeout getting atom command data.")
        return null
      }
      return decoder.decodeData(this.logger, state.message)
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

    // homekit exposes a single long-term average; prefer year, else month, else week
    const longTermRaw =
      sensorData[ATOM_RADON_YEAR_AVG]
      ?? month
      ?? sensorData[ATOM_RADON_WEEK_AVG]
    this.mapAtomRadon(next, longTermRaw, RADON_LONGTERM_AVG, RADON_LONGTERM_LEVEL)

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
    // level always derived from bq/m³ before optional pCi conversion
    const bq = Number(raw)
    target[avgKey] = this.isMetric ? bq : bq * BQ_TO_PCI_MULTIPLIER
    target[levelKey] = getRadonLevel(bq)
  }

  private applyRadonUnits(sensors: SensorMap, sensorData: SensorMap): void {
    // level always derived from bq/m³ before optional pCi conversion
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
