declare module "@abandonware/noble" {
  import { EventEmitter } from "node:events"

  export interface Advertisement {
    localName?: string
    manufacturerData?: Buffer
    serviceUuids?: string[]
    serviceData?: Array<{ uuid: string; data: Buffer }>
  }

  export interface Characteristic extends EventEmitter {
    uuid: string
    properties: string[]
    read(callback: (error: Error | null, data?: Buffer) => void): void
    write(
      data: Buffer,
      withoutResponse: boolean,
      callback?: (error?: Error | null) => void,
    ): void
    subscribe(callback?: (error?: Error | null) => void): void
    unsubscribe(callback?: (error?: Error | null) => void): void
  }

  export interface Service {
    uuid: string
    characteristics?: Characteristic[]
  }

  export interface Peripheral extends EventEmitter {
    id: string
    uuid: string
    address: string
    addressType: string
    connectable?: boolean
    advertisement: Advertisement
    rssi: number
    state: "error" | "connecting" | "connected" | "disconnecting" | "disconnected"
    connectAsync(): Promise<void>
    disconnectAsync(): Promise<void>
    discoverAllServicesAndCharacteristicsAsync(): Promise<{
      services: Service[]
      characteristics: Characteristic[]
    }>
    discoverSomeServicesAndCharacteristicsAsync(
      serviceUuids: string[],
      characteristicUuids: string[],
    ): Promise<{
      services: Service[]
      characteristics: Characteristic[]
    }>
  }

  interface Noble extends EventEmitter {
    state: string
    startScanning(
      serviceUuids?: string[] | readonly string[],
      allowDuplicates?: boolean,
      callback?: (error?: Error) => void,
    ): void
    startScanningAsync(
      serviceUuids?: string[] | readonly string[],
      allowDuplicates?: boolean,
    ): Promise<void>
    stopScanning(callback?: () => void): void
    stopScanningAsync(): Promise<void>
    on(event: "stateChange", listener: (state: string) => void): this
    on(event: "discover", listener: (peripheral: Peripheral) => void): this
    on(event: "scanStart" | "scanStop", listener: () => void): this
    removeListener(event: string, listener: (...args: any[]) => void): this
  }

  const noble: Noble
  export default noble
  export type { Noble }
}
