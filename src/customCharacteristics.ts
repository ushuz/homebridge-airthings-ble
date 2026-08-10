import type { API, Characteristic, WithUUID } from "homebridge"
import { Formats, Perms } from "homebridge"

export type CustomCharacteristicCtors = {
  RadonShortTermAverage: WithUUID<new () => Characteristic>
  RadonLongTermAverage: WithUUID<new () => Characteristic>
  VocDensity: WithUUID<new () => Characteristic>
  AirPressure: WithUUID<new () => Characteristic>
}

/** custom radon / voc helpers for HomeKit air quality sensor */
export function createCustomCharacteristics(api: API): CustomCharacteristicCtors {
  const { Characteristic } = api.hap

  class RadonShortTermAverage extends Characteristic {
    static readonly UUID = "000000C5-0000-1000-8000-0026BB765291"
    constructor() {
      super("Radon Short Term Average", RadonShortTermAverage.UUID, {
        format: Formats.FLOAT,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        unit: "Bq/m³",
        minValue: 0,
        maxValue: 65535,
        minStep: 0.01,
      })
      this.value = 0
    }
  }

  class RadonLongTermAverage extends Characteristic {
    static readonly UUID = "000000C3-0000-1000-8000-0026BB765291"
    constructor() {
      super("Radon Long Term Average", RadonLongTermAverage.UUID, {
        format: Formats.FLOAT,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        unit: "Bq/m³",
        minValue: 0,
        maxValue: 65535,
        minStep: 0.01,
      })
      this.value = 0
    }
  }

  class VocDensity extends Characteristic {
    static readonly UUID = "000000C8-0000-1000-8000-0026BB765291"
    constructor() {
      super("VOC Density", VocDensity.UUID, {
        format: Formats.FLOAT,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        unit: "ppb",
        minValue: 0,
        maxValue: 65535,
        minStep: 1,
      })
      this.value = 0
    }
  }

  class AirPressure extends Characteristic {
    static readonly UUID = "E863F10F-079E-48FF-8F27-9C2605A29F52"
    constructor() {
      super("Air Pressure", AirPressure.UUID, {
        format: Formats.FLOAT,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        unit: "hPa",
        minValue: 0,
        maxValue: 2000,
        minStep: 0.01,
      })
      this.value = 0
    }
  }

  return {
    RadonShortTermAverage: RadonShortTermAverage as WithUUID<new () => Characteristic>,
    RadonLongTermAverage: RadonLongTermAverage as WithUUID<new () => Characteristic>,
    VocDensity: VocDensity as WithUUID<new () => Characteristic>,
    AirPressure: AirPressure as WithUUID<new () => Characteristic>,
  }
}

export type CustomCharacteristics = CustomCharacteristicCtors
