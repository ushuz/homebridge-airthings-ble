import {
  ACCELEROMETER,
  CHAR_UUID_DATETIME,
  CHAR_UUID_HUMIDITY,
  CHAR_UUID_ILLUMINANCE_ACCELEROMETER,
  CHAR_UUID_RADON_1DAYAVG,
  CHAR_UUID_RADON_LONG_TERM_AVG,
  CHAR_UUID_TEMPERATURE,
  CHAR_UUID_WAVE_2_DATA,
  CHAR_UUID_WAVE_PLUS_DATA,
  CHAR_UUID_WAVEMINI_DATA,
  CO2,
  DATE_TIME,
  HUMIDITY,
  ILLUMINANCE,
  PERCENTAGE_MAX,
  PRESSURE,
  RADON_1DAY_AVG,
  RADON_LONGTERM_AVG,
  RADON_MAX,
  SensorMap,
  TEMPERATURE,
  TEMPERATURE_MAX,
  VOC,
  VOC_MAX,
} from "./const.js"

type Decoder = (raw: Buffer) => SensorMap

function validateValue(value: number, maxValue: number): number | null {
  if (value >= 0 && value <= maxValue) {
    return value
  }
  return null
}

function illuminanceConverter(value: number): number | null {
  const validated = validateValue(value, 255)
  if (validated === null) {
    return null
  }
  return Math.trunc((validated / 255) * PERCENTAGE_MAX)
}

function decodeAttr(
  name: string,
  format: "H" | "h",
  scale: number,
  maxValue?: number,
): Decoder {
  return (raw: Buffer) => {
    const value = format === "h" ? raw.readInt16LE(0) : raw.readUInt16LE(0)
    const scaled = value * scale
    if (maxValue !== undefined) {
      return { [name]: validateValue(scaled, maxValue) }
    }
    return { [name]: scaled }
  }
}

function decodeWaveDateTime(raw: Buffer): SensorMap {
  // H5B: year uint16 + month/day/hour/min/sec uint8
  const year = raw.readUInt16LE(0)
  const month = raw.readUInt8(2)
  const day = raw.readUInt8(3)
  const hour = raw.readUInt8(4)
  const minute = raw.readUInt8(5)
  const second = raw.readUInt8(6)
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return { [DATE_TIME]: dt.toISOString() }
}

function decodeWaveIllumAccel(raw: Buffer): SensorMap {
  return {
    [ILLUMINANCE]: illuminanceConverter(raw.readUInt8(0)),
    [ACCELEROMETER]: String(raw.readUInt8(1)),
  }
}

/** wave radon / wave 2 packed sensor characteristic */
export function decodeWaveRadon(raw: Buffer): SensorMap {
  // <4B8H
  const data: SensorMap = {}
  data[DATE_TIME] = new Date().toISOString()
  data[HUMIDITY] = validateValue(raw.readUInt8(1) / 2.0, PERCENTAGE_MAX)
  data[RADON_1DAY_AVG] = validateValue(raw.readUInt16LE(4), RADON_MAX)
  data[RADON_LONGTERM_AVG] = validateValue(raw.readUInt16LE(6), RADON_MAX)
  data[TEMPERATURE] = validateValue(raw.readUInt16LE(8) / 100.0, TEMPERATURE_MAX)
  return data
}

/** wave plus packed sensor characteristic */
export function decodeWavePlus(raw: Buffer): SensorMap {
  // <4B8H
  const data: SensorMap = {}
  data[DATE_TIME] = new Date().toISOString()
  data[HUMIDITY] = validateValue(raw.readUInt8(1) / 2.0, PERCENTAGE_MAX)
  data[RADON_1DAY_AVG] = validateValue(raw.readUInt16LE(4), RADON_MAX)
  data[RADON_LONGTERM_AVG] = validateValue(raw.readUInt16LE(6), RADON_MAX)
  data[TEMPERATURE] = validateValue(raw.readUInt16LE(8) / 100.0, TEMPERATURE_MAX)
  data[PRESSURE] = raw.readUInt16LE(10) / 50.0
  data[CO2] = validateValue(raw.readUInt16LE(12) * 1.0, 65534)
  data[VOC] = validateValue(raw.readUInt16LE(14) * 1.0, VOC_MAX)
  // illuminance is last of 4B header area? official uses val[0]
  // format is 4B then 8H: bytes 0-3 are B, then H at 4,6,8,10,12,14,16,18
  // official: illuminance = val[0] where val is full unpack of <4B8H
  // val[0]=byte0, val[1]=byte1 (humidity), val[2]=byte2, val[3]=byte3
  data[ILLUMINANCE] = illuminanceConverter(raw.readUInt8(0))
  return data
}

/** wave mini packed sensor characteristic (<2B5HLL) */
export function decodeWaveMini(raw: Buffer): SensorMap {
  // val[0]=B illum, val[1]=B, val[2]=H temp(K*100), val[3]=H pressure, val[4]=H humidity, val[5]=H voc
  const data: SensorMap = {}
  data[DATE_TIME] = new Date().toISOString()
  data[ILLUMINANCE] = illuminanceConverter(raw.readUInt8(0))
  data[TEMPERATURE] = validateValue(
    Math.round((raw.readUInt16LE(2) / 100.0 - 273.15) * 100) / 100,
    TEMPERATURE_MAX,
  )
  data[PRESSURE] = raw.readUInt16LE(4) / 50.0
  data[HUMIDITY] = validateValue(raw.readUInt16LE(6) / 100.0, PERCENTAGE_MAX)
  data[VOC] = validateValue(raw.readUInt16LE(8) * 1.0, VOC_MAX)
  return data
}

export const SENSOR_DECODERS: Record<string, Decoder> = {
  [CHAR_UUID_DATETIME]: decodeWaveDateTime,
  [CHAR_UUID_HUMIDITY]: decodeAttr(HUMIDITY, "H", 1 / 100, PERCENTAGE_MAX),
  [CHAR_UUID_RADON_1DAYAVG]: decodeAttr(RADON_1DAY_AVG, "H", 1.0),
  [CHAR_UUID_RADON_LONG_TERM_AVG]: decodeAttr(RADON_LONGTERM_AVG, "H", 1.0),
  [CHAR_UUID_ILLUMINANCE_ACCELEROMETER]: decodeWaveIllumAccel,
  [CHAR_UUID_TEMPERATURE]: decodeAttr(TEMPERATURE, "h", 1 / 100),
  [CHAR_UUID_WAVE_2_DATA]: decodeWaveRadon,
  [CHAR_UUID_WAVE_PLUS_DATA]: decodeWavePlus,
  [CHAR_UUID_WAVEMINI_DATA]: decodeWaveMini,
}

export function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, "")
}

/** lookup decoder by full or short uuid */
export function getSensorDecoder(uuid: string): Decoder | undefined {
  const key = uuid.toLowerCase()
  if (SENSOR_DECODERS[key]) {
    return SENSOR_DECODERS[key]
  }
  const compact = normalizeUuid(uuid)
  for (const [k, decoder] of Object.entries(SENSOR_DECODERS)) {
    if (normalizeUuid(k) === compact) {
      return decoder
    }
  }
  return undefined
}
