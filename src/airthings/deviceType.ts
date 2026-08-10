/** airthings product model ids (from model number characteristic) */
export enum AirthingsDeviceType {
  UNKNOWN = "0",
  WAVE_GEN_1 = "2900",
  WAVE_MINI = "2920",
  WAVE_PLUS = "2930",
  WAVE_RADON = "2950",
  WAVE_ENHANCE_EU = "3210",
  WAVE_ENHANCE_US = "3220",
  CORENTIUM_HOME_2 = "3250",
}

const ATOM_DEVICES = new Set<AirthingsDeviceType>([
  AirthingsDeviceType.WAVE_ENHANCE_EU,
  AirthingsDeviceType.WAVE_ENHANCE_US,
  AirthingsDeviceType.CORENTIUM_HOME_2,
])

export function isAtomDevice(model: AirthingsDeviceType): boolean {
  return ATOM_DEVICES.has(model)
}

export function deviceTypeFromRaw(value: string): AirthingsDeviceType {
  const match = (Object.values(AirthingsDeviceType) as string[]).find((v) => v === value)
  if (match) {
    return match as AirthingsDeviceType
  }
  return AirthingsDeviceType.UNKNOWN
}

export function productName(model: AirthingsDeviceType): string {
  switch (model) {
    case AirthingsDeviceType.WAVE_GEN_1:
      return "Wave Gen 1"
    case AirthingsDeviceType.WAVE_MINI:
      return "Wave Mini"
    case AirthingsDeviceType.WAVE_PLUS:
      return "Wave Plus"
    case AirthingsDeviceType.WAVE_RADON:
      return "Wave Radon"
    case AirthingsDeviceType.WAVE_ENHANCE_EU:
    case AirthingsDeviceType.WAVE_ENHANCE_US:
      return "Wave Enhance"
    case AirthingsDeviceType.CORENTIUM_HOME_2:
      return "Corentium Home 2"
    default:
      return "Unknown"
  }
}

function interpolate(
  voltage: number,
  voltageRange: [number, number],
  percentageRange: [number, number],
): number {
  return (
    ((voltage - voltageRange[0]) / (voltageRange[1] - voltageRange[0]))
    * (percentageRange[1] - percentageRange[0])
    + percentageRange[0]
  )
}

function twoBatteries(voltage: number): number {
  if (voltage >= 3.0) return 100
  if (voltage >= 2.8) return interpolate(voltage, [2.8, 3.0], [81, 100])
  if (voltage >= 2.6) return interpolate(voltage, [2.6, 2.8], [53, 81])
  if (voltage >= 2.5) return interpolate(voltage, [2.5, 2.6], [28, 53])
  if (voltage >= 2.2) return interpolate(voltage, [2.2, 2.5], [5, 28])
  if (voltage >= 2.1) return interpolate(voltage, [2.1, 2.2], [0, 5])
  return 0
}

function threeBatteries(voltage: number): number {
  if (voltage >= 4.5) return 100
  if (voltage >= 4.2) return interpolate(voltage, [4.2, 4.5], [85, 100])
  if (voltage >= 3.9) return interpolate(voltage, [3.9, 4.2], [62, 85])
  if (voltage >= 3.75) return interpolate(voltage, [3.75, 3.9], [42, 62])
  if (voltage >= 3.3) return interpolate(voltage, [3.3, 3.75], [23, 42])
  if (voltage >= 2.4) return interpolate(voltage, [2.4, 3.3], [0, 23])
  return 0
}

/** convert battery voltage (V) to percentage */
export function batteryPercentage(model: AirthingsDeviceType, voltage: number): number {
  if (model === AirthingsDeviceType.WAVE_MINI) {
    return Math.round(threeBatteries(voltage))
  }
  return Math.round(twoBatteries(voltage))
}
