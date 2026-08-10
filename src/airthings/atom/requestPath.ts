export enum AtomRequestPath {
  LATEST_VALUES = "29999/0/31012",
  CONNECTIVITY_MODE = "17/0/31100",
}

/** encode a short utf-8 string as cbor text (major type 3) */
export function encodeCborText(value: string): Buffer {
  const payload = Buffer.from(value, "utf-8")
  if (payload.length > 23) {
    // definite length 1-byte (24..255)
    if (payload.length > 255) {
      throw new Error("CBOR text too long")
    }
    return Buffer.concat([Buffer.from([0x78, payload.length]), payload])
  }
  return Buffer.concat([Buffer.from([0x60 + payload.length]), payload])
}

export function pathAsCbor(path: AtomRequestPath): Buffer {
  return encodeCborText(path)
}

export function pathAsBytes(path: AtomRequestPath): Buffer {
  return Buffer.from(path, "utf-8")
}
