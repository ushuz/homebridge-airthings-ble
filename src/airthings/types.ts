import type { SensorMap } from "./const.js"
import type { AirthingsDeviceType } from "./deviceType.js"

export interface AirthingsDeviceInfo {
  manufacturer: string
  hwVersion: string
  swVersion: string
  model: AirthingsDeviceType
  name: string
  identifier: string
  address: string
}

export interface AirthingsDevice extends AirthingsDeviceInfo {
  sensors: SensorMap
  lastUpdateAt: number
}

export function emptyDevice(partial?: Partial<AirthingsDevice>): AirthingsDevice {
  return {
    manufacturer: "Airthings",
    hwVersion: "",
    swVersion: "",
    model: partial?.model ?? ("0" as AirthingsDeviceType),
    name: "",
    identifier: "",
    address: "",
    sensors: {},
    lastUpdateAt: 0,
    ...partial,
  }
}
