import { randomBytes as nodeRandomBytes } from "node:crypto"
import { AtomRequestPath, pathAsCbor } from "./requestPath.js"

export class AtomRequest {
  url: AtomRequestPath
  randomBytes: Buffer

  constructor(url: AtomRequestPath, randomBytes?: Buffer) {
    this.url = url
    if (randomBytes !== undefined) {
      if (randomBytes.length !== 2) {
        throw new Error("Random bytes must be exactly 2 bytes long")
      }
      this.randomBytes = randomBytes
    } else {
      this.randomBytes = nodeRandomBytes(2)
    }
  }

  asBytes(): Buffer {
    return Buffer.concat([
      Buffer.from("0301", "hex"),
      this.randomBytes,
      Buffer.from("81A100", "hex"),
      pathAsCbor(this.url),
    ])
  }
}
