import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { childPathsFromIntrospect } from "../src/ble/nodeBle.js"

describe("childPathsFromIntrospect", () => {
  it("extracts immediate bluez device nodes", () => {
    const xml = `<?xml version="1.0"?>
<node>
  <interface name="org.bluez.Adapter1"/>
  <node name="dev_B0_D2_78_60_5D_4F"/>
  <node name="dev_CD_35_34_35_0C_6A"/>
</node>`
    assert.deepEqual(childPathsFromIntrospect("/org/bluez/hci0", xml), [
      "/org/bluez/hci0/dev_B0_D2_78_60_5D_4F",
      "/org/bluez/hci0/dev_CD_35_34_35_0C_6A",
    ])
  })

  it("ignores nested path names", () => {
    const xml = "<node><node name=\"hci0/dev_AA\"/></node>"
    assert.deepEqual(childPathsFromIntrospect("/org/bluez", xml), [])
  })
})
