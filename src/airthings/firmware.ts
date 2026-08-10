/** firmware version helpers ported from airthings-ble airthings_firmware.py */

export type VersionTriple = [number, number, number]

export function parseFirmwareVersion(version: string | null | undefined): VersionTriple | null {
  if (!version) {
    return null
  }
  // semantic X.Y.Z
  const semantic = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (semantic) {
    return [Number(semantic[1]), Number(semantic[2]), Number(semantic[3])]
  }
  // airthings: T-SUB-2.6.1-master+0
  const airthings = /^[A-Z]-SUB-(\d+)\.(\d+)\.(\d+)-.*/.exec(version)
  if (airthings) {
    return [Number(airthings[1]), Number(airthings[2]), Number(airthings[3])]
  }
  return null
}

function isOlder(current: VersionTriple, required: VersionTriple): boolean {
  for (let i = 0; i < 3; i++) {
    if (current[i] < required[i]) return true
    if (current[i] > required[i]) return false
  }
  return false
}

export function formatVersion(v: VersionTriple): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

/** required firmware for atom gatt path reliability */
export function requiredFirmwareForModel(model: string): string | null {
  if (model === "3210" || model === "3220") {
    return "T-SUB-2.6.1-master+0"
  }
  if (model === "3250") {
    return "R-SUB-1.3.4-master+0"
  }
  return null
}

export function needsFirmwareUpgrade(
  currentVersion: string | null | undefined,
  requiredVersion: string | null | undefined,
): boolean {
  const current = parseFirmwareVersion(currentVersion)
  const required = parseFirmwareVersion(requiredVersion)
  if (!current || !required) {
    return false
  }
  return isOlder(current, required)
}
