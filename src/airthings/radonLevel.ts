export type RadonLevelName = "good" | "fair" | "poor" | "unknown"

interface Level {
  min: number | null
  max: number | null
  name: RadonLevelName
}

/** thresholds in bq/m³ (same as official airthings-ble) */
const LEVELS: Level[] = [
  { min: 0, max: 100, name: "good" },
  { min: 100, max: 150, name: "fair" },
  { min: 150, max: null, name: "poor" },
]

function inRange(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value < max)
}

export function getRadonLevel(value: number): RadonLevelName {
  for (const level of LEVELS) {
    if (inRange(value, level.min, level.max)) {
      return level.name
    }
  }
  return "unknown"
}
