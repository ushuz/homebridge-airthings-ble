import { createRequire } from "node:module"

/**
 * thin wrappers around node-ble (bluez/dbus).
 * linux-only; pure js — no hci socket, so peers can share the adapter.
 *
 * dbus-next 0.10.2 (node-ble's bus) swaps the arguments to
 * `hasOwnProperty` in `_addMatch` / `_removeMatch`, so every signal
 * subscription sends AddMatch and RemoveMatch is never sent. node-ble
 * also drops its proxy on disconnect (`_ready = false`), so the next
 * poll builds a new proxy and leaks another match rule. together with
 * a Device watch per nearby address, that hits
 * max_match_rules_per_connection and wedges BlueZ discovery.
 *
 * keep in sync with @ushuz/homebridge-govee-ble `src/ble/nodeBle.ts`
 * (module format differs: this package is esm, govee is cjs).
 */

const require = createRequire(import.meta.url)

// node-ble is cjs (`export =`)
const nodeBle = require("node-ble") as {
  createBluetooth: () => {
    bluetooth: NodeBleBluetooth
    destroy: () => void
  }
}

export interface NodeBleBluetooth {
  adapters(): Promise<string[]>
  defaultAdapter(): Promise<NodeBleAdapter>
  getAdapter(adapter: string): Promise<NodeBleAdapter>
}

export interface NodeBleAdapter {
  getAddress(): Promise<string>
  getName(): Promise<string>
  isPowered(): Promise<boolean>
  isDiscovering(): Promise<boolean>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<string[]>
  getDevice(address: string): Promise<NodeBleDevice>
  waitDevice(address: string, timeout?: number, discoveryInterval?: number): Promise<NodeBleDevice>
}

export interface NodeBleDevice {
  getName(): Promise<string>
  getAddress(): Promise<string>
  getAlias(): Promise<string>
  getRSSI(): Promise<number | string>
  getManufacturerData(): Promise<Record<string, unknown> | null>
  isConnected(): Promise<boolean | string>
  connect(): Promise<void>
  disconnect(): Promise<void>
  gatt(): Promise<NodeBleGattServer>
  on(event: "connect" | "disconnect", listener: (...args: unknown[]) => void): this
  removeListener(event: string, listener: (...args: unknown[]) => void): this
}

export interface NodeBleGattServer {
  services(): Promise<string[]>
  getPrimaryService(uuid: string): Promise<NodeBleGattService>
}

export interface NodeBleGattService {
  getUUID(): Promise<string>
  characteristics(): Promise<string[]>
  getCharacteristic(uuid: string): Promise<NodeBleGattCharacteristic>
}

export interface NodeBleGattCharacteristic {
  getUUID(): Promise<string>
  readValue(offset?: number): Promise<Buffer>
  writeValue(buffer: Buffer, optionsOrOffset?: number | { offset?: number, type?: string }): Promise<void>
  writeValueWithoutResponse(buffer: Buffer, offset?: number): Promise<void>
  writeValueWithResponse(buffer: Buffer, offset?: number): Promise<void>
  startNotifications(): Promise<void>
  stopNotifications(): Promise<void>
  on(event: "valuechanged", listener: (buffer: Buffer) => void): this
  removeListener(event: "valuechanged", listener: (buffer: Buffer) => void): this
  off?(event: "valuechanged", listener: (buffer: Buffer) => void): this
}

export interface BleBus {
  adapter: NodeBleAdapter
  adapterName: string
  destroy(): void
}

/** injectable factory for tests */
export type BleBusFactory = (hciDeviceId: number) => Promise<BleBus>

const Device = require("node-ble/src/Device") as new (
  dbus: unknown,
  adapter: string,
  device: string,
) => NodeBleDevice
const BusHelper = require("node-ble/src/BusHelper") as {
  prototype: {
    children: () => Promise<string[]>
    _prepare: () => Promise<void>
    removeListeners: () => void
    waitPropChange: (propName: string) => Promise<unknown>
  }
  buildChildren: (path: string, nodes: string[]) => string[]
}

const GattCharacteristic = require("node-ble/src/GattCharacteristic") as {
  prototype: { stopNotifications: () => Promise<void> }
}

type MatchBus = {
  _matchRules?: Record<string, number>
  _connection?: { stream?: { writable?: boolean } }
  call: (msg: unknown) => Promise<unknown>
}

/** in-flight GattServer ServicesResolved waits; cancelled on disconnect */
const pendingPropWaits = new Set<() => void>()

let blePatchesInstalled = false

/**
 * install process-wide node-ble / dbus-next fixes. idempotent.
 * called on import so tests cover the patches without a live bus.
 */
export function installBlePatches(): void {
  if (blePatchesInstalled) return
  blePatchesInstalled = true
  patchDbusMatchRefcount()
  patchBusHelperLifecycle()
  patchCharacteristicStop()
  patchGattServerInit()
}

/** a failed or abandoned gatt init must not keep service/characteristic proxies */
function patchGattServerInit(): void {
  const GattServer = require("node-ble/src/GattServer") as {
    prototype: {
      init: () => Promise<void>
      __initPatched?: boolean
    }
  }
  const proto = GattServer.prototype
  if (proto.__initPatched) return
  proto.__initPatched = true
  const origInit = proto.init
  proto.init = async function initDisposeOnFailure(this: unknown) {
    try {
      return await origInit.call(this)
    } catch (err) {
      disposeGattServer(this)
      throw err
    }
  }
}

/**
 * dbus-next 0.10.2 calls `hasOwnProperty(match, rules)` instead of
 * `hasOwnProperty(rules, match)`, so the refcount never hits and
 * RemoveMatch is unreachable. each .on('PropertiesChanged') then
 * permanently consumes one of the 2048 per-connection match rules.
 */
function patchDbusMatchRefcount(): void {
  const MessageBus = require("dbus-next/lib/bus") as { prototype: MatchBus & {
    __matchRefcountPatched?: boolean
    _addMatch: (match: string) => Promise<unknown>
    _removeMatch: (match: string) => Promise<unknown>
  } }
  const { Message } = require("dbus-next") as {
    Message: new (msg: Record<string, unknown>) => unknown
  }
  const proto = MessageBus.prototype
  if (proto.__matchRefcountPatched) return
  proto.__matchRefcountPatched = true

  const matchMessage = (member: "AddMatch" | "RemoveMatch", match: string) => new Message({
    path: "/org/freedesktop/DBus",
    destination: "org.freedesktop.DBus",
    interface: "org.freedesktop.DBus",
    member,
    signature: "s",
    body: [match],
  })

  proto._addMatch = function addMatchRefcounted(this: MatchBus, match: string) {
    const rules = this._matchRules ?? (this._matchRules = {})
    if (Object.prototype.hasOwnProperty.call(rules, match)) {
      rules[match] += 1
      return Promise.resolve()
    }
    rules[match] = 1
    return this.call(matchMessage("AddMatch", match))
  }

  proto._removeMatch = function removeMatchRefcounted(this: MatchBus, match: string) {
    if (!this._connection?.stream?.writable) {
      return Promise.resolve()
    }
    const rules = this._matchRules
    if (!rules || !Object.prototype.hasOwnProperty.call(rules, match)) {
      return Promise.resolve()
    }
    rules[match] -= 1
    if (rules[match] > 0) {
      return Promise.resolve()
    }
    delete rules[match]
    return this.call(matchMessage("RemoveMatch", match))
  }
}

/**
 * keep one proxy and one PropertiesChanged subscription per helper.
 * node-ble's removeListeners() set `_ready = false` after wiping the
 * proxy listeners, and the next property read constructed a new
 * ProxyObject (another AddMatch that was never removed).
 */
function patchBusHelperLifecycle(): void {
  const proto = BusHelper.prototype as {
    __lifecyclePatched?: boolean
    _prepare: (this: {
      _ready?: boolean
      _objectProxy?: unknown
      _ifaceProxy?: unknown
      _propsProxy?: unknown
      options?: { useProps?: boolean }
    }) => Promise<void>
    removeListeners: (this: { removeAllListeners?: (event?: string) => void }) => void
    waitPropChange: (this: {
      iface?: string
      _prepare: () => Promise<void>
      _propsProxy?: {
        on: (event: string, cb: (...args: unknown[]) => void) => void
        off: (event: string, cb: (...args: unknown[]) => void) => void
      }
    }, propName: string) => Promise<unknown>
  }
  if (proto.__lifecyclePatched) return
  proto.__lifecyclePatched = true

  const origPrepare = proto._prepare
  proto._prepare = async function prepareReuseProxy(this: {
    _ready?: boolean
    _objectProxy?: unknown
    _ifaceProxy?: unknown
    _propsProxy?: unknown
    options?: { useProps?: boolean }
  }) {
    if (this._ready) return
    if (
      this._objectProxy
      && this._ifaceProxy
      && (!this.options?.useProps || this._propsProxy)
    ) {
      this._ready = true
      return
    }
    await origPrepare.call(this)
  }

  proto.removeListeners = function removeEmitterListenersOnly(this: {
    removeAllListeners?: (event?: string) => void
  }) {
    this.removeAllListeners?.("PropertiesChanged")
  }

  proto.waitPropChange = async function waitPropChangeCancellable(
    this: {
      iface?: string
      _prepare: () => Promise<void>
      _propsProxy?: {
        on: (event: string, cb: (...args: unknown[]) => void) => void
        off: (event: string, cb: (...args: unknown[]) => void) => void
      }
    },
    propName: string,
  ) {
    await this._prepare()
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        pendingPropWaits.delete(cancel)
        try {
          this._propsProxy?.off("PropertiesChanged", cb)
        } catch {
          // ignore
        }
      }
      const cancel = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error("stopped waiting for property change"))
      }
      const cb = (iface: unknown, changedProps: unknown) => {
        if (settled) return
        if (!changedProps || typeof changedProps !== "object") return
        const props = changedProps as Record<string, { value?: unknown }>
        if (iface !== this.iface || !Object.prototype.hasOwnProperty.call(props, propName)) {
          return
        }
        settled = true
        cleanup()
        resolve(props[propName]?.value)
      }
      pendingPropWaits.add(cancel)
      this._propsProxy?.on("PropertiesChanged", cb)
    })
  }

  patchBusHelperChildren()
}

/**
 * StopNotify can time out while the valuechanged forwarder stays
 * attached. drop the BusHelper listener even when the dbus call fails.
 * the proxy subscription itself stays (one match rule per characteristic).
 */
function patchCharacteristicStop(): void {
  const proto = GattCharacteristic.prototype as {
    __stopPatched?: boolean
    stopNotifications: (this: {
      helper?: { callMethod?: (name: string) => Promise<unknown>, removeAllListeners?: (event?: string) => void }
    }) => Promise<void>
  }
  if (proto.__stopPatched) return
  proto.__stopPatched = true
  proto.stopNotifications = async function stopNotificationsReleaseListener(this: {
    helper?: { callMethod?: (name: string) => Promise<unknown>, removeAllListeners?: (event?: string) => void }
  }) {
    const clear = () => {
      try {
        this.helper?.removeAllListeners?.("PropertiesChanged")
      } catch {
        // ignore
      }
    }
    clear()
    try {
      await this.helper?.callMethod?.("StopNotify")
    } finally {
      clear()
    }
  }
}

/** drop ServicesResolved watches left behind by an abandoned gatt init */
export function releaseDbusPropertyWaits(): void {
  for (const cancel of [...pendingPropWaits]) {
    try {
      cancel()
    } catch {
      // ignore
    }
  }
}

let busHelperPatched = false

/** open dbus connection and bind the configured hciN adapter (no silent fallback) */
export async function openBleBus(hciDeviceId = 0): Promise<BleBus> {
  installBlePatches()
  const { bluetooth, destroy } = nodeBle.createBluetooth()
  // node-ble does not handle dbus 'error'; unhandled emitters crash the process
  const dbus = (bluetooth as { dbus?: { on?: (event: string, cb: (err: Error) => void) => void } }).dbus
  if (dbus?.on) {
    dbus.on("error", (err: Error) => {
      // do not destroy() — that orphans an in-flight adapter lock
      process.stderr.write(`[node-ble] dbus error: ${err?.message || err}\n`)
    })
  }
  try {
    const adapters = await bluetooth.adapters()
    const preferred = `hci${hciDeviceId}`
    if (!adapters.includes(preferred)) {
      throw new Error(
        `bluetooth adapter ${preferred} not found via bluez`
        + (adapters.length ? ` (available: ${adapters.join(", ")})` : ""),
      )
    }
    const adapter = await bluetooth.getAdapter(preferred)
    if (!(await adapter.isPowered())) {
      throw new Error(`bluetooth adapter ${preferred} is not powered`)
    }
    patchAdapterDeviceCache(adapter)
    return { adapter, adapterName: preferred, destroy }
  } catch (err) {
    try {
      destroy()
    } catch {
      // ignore
    }
    throw err
  }
}

/**
 * node-ble BusHelper.children() rebuilds a dbus-next ProxyObject every call.
 * each new proxy adds AddMatch rules until dbus hits max_match_rules (2048).
 * reuse the existing proxy and refresh the child list via introspect.
 */
function patchBusHelperChildren(): void {
  if (busHelperPatched) {
    return
  }
  BusHelper.prototype.children = async function childrenReuseProxy(this: {
    _ready?: boolean
    _prepare: () => Promise<void>
    _objectProxy?: {
      nodes?: string[]
      interfaces?: Record<string, { Introspect?: () => Promise<string> }>
      getInterface?: (name: string) => { Introspect: () => Promise<string> }
    }
    object: string
  }): Promise<string[]> {
    if (!this._ready) {
      await this._prepare()
    }
    const xml = await introspectXml(this)
    if (this._objectProxy) {
      this._objectProxy.nodes = childPathsFromIntrospect(this.object, xml)
    }
    return BusHelper.buildChildren(this.object, this._objectProxy?.nodes ?? [])
  }
  busHelperPatched = true
}

async function introspectXml(helper: {
  _objectProxy?: {
    interfaces?: Record<string, { Introspect?: () => Promise<string> }>
    getInterface?: (name: string) => { Introspect: () => Promise<string> }
  }
}): Promise<string> {
  const proxy = helper._objectProxy
  if (!proxy) {
    return "<node></node>"
  }
  const named = proxy.interfaces?.["org.freedesktop.DBus.Introspectable"]
  if (named?.Introspect) {
    return named.Introspect()
  }
  try {
    const iface = proxy.getInterface?.("org.freedesktop.DBus.Introspectable")
    if (iface?.Introspect) {
      return iface.Introspect()
    }
  } catch {
    // ignore
  }
  return "<node></node>"
}

/** parse immediate child object paths from introspect xml */
export function childPathsFromIntrospect(parentPath: string, xml: string): string[] {
  const paths: string[] = []
  const re = /<node\s+name="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const name = match[1]
    if (!name || name.includes("/")) {
      continue
    }
    paths.push(`${parentPath}/${name}`)
  }
  return paths
}

function patchAdapterDeviceCache(adapter: NodeBleAdapter): void {
  const anyAdapter = adapter as NodeBleAdapter & {
    dbus?: unknown
    adapter?: string
    __deviceCache?: Map<string, NodeBleDevice>
  }
  const cache = anyAdapter.__deviceCache ?? new Map<string, NodeBleDevice>()
  anyAdapter.__deviceCache = cache
  const adapterName = anyAdapter.adapter ?? "hci0"

  adapter.getDevice = async (uuid: string) => {
    const formatted = formatBleAddress(uuid)
    const listed = await adapter.devices()
    const onBus = listed.some((address) => formatBleAddress(address) === formatted)
    if (!onBus) {
      const stale = cache.get(formatted)
      cache.delete(formatted)
      disposeDevice(stale)
      throw new Error("Device not found")
    }
    const existing = cache.get(formatted)
    if (existing) {
      return existing
    }
    const serialized = `dev_${formatted.toUpperCase().replace(/:/g, "_")}`
    const device = hardenDevice(new Device(anyAdapter.dbus, adapterName, serialized))
    cache.set(formatted, device)
    return device
  }
}

export function forgetCachedDevice(adapter: NodeBleAdapter, address: string): NodeBleDevice | undefined {
  const cache = (adapter as NodeBleAdapter & {
    __deviceCache?: Map<string, NodeBleDevice>
  }).__deviceCache
  const formatted = formatBleAddress(address)
  const existing = cache?.get(formatted)
  cache?.delete(formatted)
  if (existing) disposeDevice(existing)
  return existing
}

interface DisposableHelper {
  __disposed?: boolean
  removeAllListeners?: (event?: string) => void
  _propsProxy?: { removeAllListeners?: (event?: string) => void } | null
  _ready?: boolean
  _objectProxy?: unknown
  _ifaceProxy?: unknown
}

/** release dbus signal subscriptions held by a node-ble BusHelper */
export function disposeBusHelper(helper: DisposableHelper | undefined): void {
  if (!helper || helper.__disposed) return
  helper.__disposed = true
  try {
    helper.removeAllListeners?.("PropertiesChanged")
  } catch {
    // ignore
  }
  try {
    helper._propsProxy?.removeAllListeners?.("PropertiesChanged")
  } catch {
    // ignore
  }
  helper._ready = false
  helper._objectProxy = null
  helper._ifaceProxy = null
  helper._propsProxy = null
}

/** drop a device and every gatt proxy it opened */
export function disposeDevice(device: NodeBleDevice | undefined): void {
  if (!device) return
  const anyDevice = device as NodeBleDevice & {
    __disposed?: boolean
    helper?: DisposableHelper
    __airthingsGatt?: unknown
  }
  if (anyDevice.__disposed) return
  anyDevice.__disposed = true
  disposeBusHelper(anyDevice.helper)
  disposeGattServer(anyDevice.__airthingsGatt)
  anyDevice.__airthingsGatt = undefined
}

function disposeGattServer(gatt: unknown): void {
  if (!gatt || typeof gatt !== "object") return
  const server = gatt as {
    __disposed?: boolean
    helper?: DisposableHelper
    _services?: Record<string, {
      helper?: DisposableHelper
      _characteristics?: Record<string, { helper?: DisposableHelper }>
    }>
  }
  if (server.__disposed) return
  server.__disposed = true
  disposeBusHelper(server.helper)
  for (const service of Object.values(server._services ?? {})) {
    disposeBusHelper(service?.helper)
    for (const characteristic of Object.values(service?._characteristics ?? {})) {
      disposeBusHelper(characteristic?.helper)
    }
  }
}

export function isMissingBluezInterface(error: unknown): boolean {
  return /interface not found in proxy object/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

function hardenDevice(device: NodeBleDevice): NodeBleDevice {
  const anyDevice = device as NodeBleDevice & {
    __hardened?: boolean
    __airthingsGatt?: NodeBleGattServer
    helper?: { removeListeners?: () => void }
    gatt?: () => Promise<NodeBleGattServer>
  }
  if (anyDevice.__hardened) {
    return device
  }
  anyDevice.__hardened = true

  const origConnect = device.connect.bind(device)
  const origDisconnect = device.disconnect.bind(device)
  device.connect = async () => {
    if (await isDeviceConnected(device)) {
      return
    }
    await origConnect()
  }
  device.disconnect = async () => {
    // cancel a GattServer.init stuck on ServicesResolved before the
    // dbus Disconnect, and keep the device proxy (removeListeners no
    // longer rebuilds it).
    releaseDbusPropertyWaits()
    try {
      await origDisconnect()
    } finally {
      try {
        anyDevice.helper?.removeListeners?.()
      } catch {
        // ignore
      }
    }
  }

  const origGatt = device.gatt.bind(device)
  let gattCached: NodeBleGattServer | undefined
  device.gatt = async () => {
    if (gattCached) {
      try {
        const services = await gattCached.services()
        if (services.length > 0) {
          anyDevice.__airthingsGatt = gattCached
          return gattCached
        }
      } catch {
        // remap below
      }
      disposeGattServer(gattCached)
      gattCached = undefined
      anyDevice.__airthingsGatt = undefined
    }
    gattCached = await origGatt()
    anyDevice.__airthingsGatt = gattCached
    return gattCached
  }

  return device
}

async function isDeviceConnected(device: NodeBleDevice): Promise<boolean> {
  try {
    const value = await device.isConnected()
    return value === true || value === "true"
  } catch {
    return false
  }
}

/**
 * bluez manufacturer data is { [companyId]: Buffer }.
 * reconstruct classic ad payload (company id le + payload) for parsers.
 */
export function manufacturerPayloads(
  mfg: Record<string, unknown> | null | undefined,
): Buffer[] {
  if (!mfg) {
    return []
  }
  const out: Buffer[] = []
  for (const [id, value] of Object.entries(mfg)) {
    const companyId = Number(id)
    if (!Number.isFinite(companyId)) {
      continue
    }
    const payload = toBuffer(value)
    if (!payload) {
      continue
    }
    const buf = Buffer.allocUnsafe(2 + payload.length)
    buf.writeUInt16LE(companyId & 0xffff, 0)
    payload.copy(buf, 2)
    out.push(buf)
  }
  return out
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data)
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  return null
}

export function normalizeBleAddress(address: string): string {
  // accept aa:bb:..., aa-bb-..., or aabbccddeeff
  const hex = address.trim().toLowerCase().replace(/[^0-9a-f]/g, "")
  if (hex.length === 12) {
    return hex.match(/.{2}/g)!.join(":")
  }
  return address.trim().toLowerCase().replace(/-/g, ":")
}

/** colon-separated uppercase form used by some bluez paths */
export function formatBleAddress(address: string): string {
  return normalizeBleAddress(address).toUpperCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ensure le discovery is running.
 * bluez discovery is owned by the dbus client that started it. try stop (only
 * works if we own the session), then start; on "already in progress" piggyback.
 * if start still fails, power-cycle the adapter to clear a stuck session.
 * returns whether this call started discovery (caller should stop only if true).
 * a thrown error does not leave a session this client started.
 */
export async function ensureDiscovery(adapter: NodeBleAdapter): Promise<boolean> {
  let stopped = false
  try {
    if (await adapter.isDiscovering()) {
      await adapter.stopDiscovery()
      stopped = true
    }
  } catch {
    // another client owns the session, or the property read failed
  }
  if (stopped) {
    await sleep(150)
  }

  if (await adapter.isDiscovering().catch(() => false)) {
    // could not stop — piggyback on existing discovery
    return false
  }

  try {
    await adapter.startDiscovery()
    return true
  } catch (err) {
    const msg = String((err as Error)?.message || err)
    if (/already in progress/i.test(msg)) {
      return false
    }
    // last resort: power-cycle adapter to clear orphan discovery
    try {
      await powerCycleAdapter(adapter)
      await adapter.startDiscovery()
      return true
    } catch (startErr) {
      await stopOwnedDiscovery(adapter)
      throw startErr instanceof Error ? startErr : err
    }
  }
}

/**
 * stop discovery if this dbus client owns the session.
 * BlueZ StopDiscovery only cancels the caller, so another plugin's scan
 * is left running. errors (not discovering, not our session) are ignored.
 */
export async function stopOwnedDiscovery(adapter: NodeBleAdapter): Promise<void> {
  try {
    if (await adapter.isDiscovering()) {
      await adapter.stopDiscovery()
    }
  } catch {
    // ignore
  }
}

/**
 * run `fn` while discovery is active, then always stop a session we started.
 * discovery is not left on for the next poll, including when `fn` throws
 * (Device not found, timeout).
 */
export async function usingDiscovery<T>(
  adapter: NodeBleAdapter,
  fn: () => Promise<T>,
): Promise<T> {
  let startedHere = false
  try {
    startedHere = await ensureDiscovery(adapter)
    return await fn()
  } finally {
    await stopDiscoveryIfStarted(adapter, startedHere)
    if (startedHere) {
      await stopOwnedDiscovery(adapter)
    }
  }
}

/** power-cycle adapter via node-ble BusHelper (clears stuck Discovering) */
async function powerCycleAdapter(adapter: NodeBleAdapter): Promise<void> {
  const anyAdapter = adapter as unknown as {
    helper?: { set: (prop: string, value: unknown) => Promise<void> }
  }
  if (!anyAdapter.helper?.set) {
    return
  }
  // dbus-next Variant — same shape node-ble buildTypedValue uses
  const { Variant } = require("dbus-next") as {
    Variant: new (sig: string, value: unknown) => unknown
  }
  await anyAdapter.helper.set("Powered", new Variant("b", false))
  await sleep(300)
  await anyAdapter.helper.set("Powered", new Variant("b", true))
  await sleep(400)
}

export async function stopDiscoveryIfStarted(
  adapter: NodeBleAdapter,
  startedHere: boolean,
): Promise<void> {
  if (!startedHere) {
    return
  }
  try {
    if (await adapter.isDiscovering()) {
      await adapter.stopDiscovery()
    }
  } catch {
    // ignore
  }
}

/** discover every characteristic under every primary service */
export async function mapAllCharacteristics(
  device: NodeBleDevice,
): Promise<Map<string, { uuid: string, char: NodeBleGattCharacteristic }>> {
  const gatt = await device.gatt()
  const services = await gatt.services()
  const byUuid = new Map<string, { uuid: string, char: NodeBleGattCharacteristic }>()
  for (const serviceUuid of services) {
    try {
      const service = await gatt.getPrimaryService(serviceUuid)
      const chars = await service.characteristics()
      for (const charUuid of chars) {
        try {
          const char = await service.getCharacteristic(charUuid)
          byUuid.set(uuidKey(charUuid), { uuid: charUuid, char })
        } catch {
          // skip unreadable chars
        }
      }
    } catch {
      // skip services that fail to open
    }
  }
  return byUuid
}

installBlePatches()

export function uuidKey(uuid: string): string {
  const compact = uuid.replace(/-/g, "").toLowerCase()
  if (compact.length === 4) {
    return `0000${compact}00001000800000805f9b34fb`
  }
  if (compact.length === 8) {
    return `${compact}00001000800000805f9b34fb`
  }
  return compact
}
