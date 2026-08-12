# @ushuz/homebridge-airthings-ble

Homebridge plugin for [Airthings](https://www.airthings.com/) air quality monitors over **Bluetooth LE**.

Sensor protocol is ported from the official [Airthings BLE library](https://github.com/Airthings/airthings-ble) used by Home Assistant.

BLE stack: [`node-ble`](https://www.npmjs.com/package/node-ble) (BlueZ over D-Bus, pure JavaScript — no native HCI bindings). **Linux only** (Raspberry Pi / Homebridge OS).

## Supported devices

- Wave Gen 1
- Wave Mini
- Wave Plus
- Wave Radon (Wave 2)
- Wave Enhance
- Corentium Home 2

**Not supported** (BLE used only for onboarding): Hub, Renew, View series.

## Requirements

| Component | Version |
| --- | --- |
| Homebridge | 1.8.5+ (2.x also supported) |
| Node.js | 20.18.0+ (or 22.x) |
| OS | Linux with BlueZ (Raspberry Pi) |

### Raspberry Pi / Linux Bluetooth

```bash
sudo apt-get update
sudo apt-get install -y bluetooth bluez
sudo systemctl enable --now bluetooth
```

`node-ble` talks to BlueZ on the system D-Bus. Ensure the Homebridge user can use `org.bluez` (membership in the `bluetooth` group, or a D-Bus policy such as the one in the [node-ble README](https://github.com/chrvadala/node-ble#provide-permissions)).

No `setcap` / raw HCI capabilities are required (unlike noble).

## Install

```bash
hb-service add @ushuz/homebridge-airthings-ble
# or
npm install -g @ushuz/homebridge-airthings-ble
```

Restart Homebridge after install.

## Config

Example `config.json` platform block:

```json
{
  "platform": "AirthingsBLE",
  "name": "Airthings BLE",
  "refreshInterval": 300,
  "scanDuration": 20,
  "isMetric": true,
  "co2AlertThreshold": 1000,
  "hciDeviceId": 0,
  "debug": false,
  "devices": []
}
```

| Field | Default | Description |
| --- | --- | --- |
| `refreshInterval` | `300` | Seconds between BLE polls (min 300 = 5 minutes). |
| `scanDuration` | `20` | Seconds to scan at startup. |
| `isMetric` | `true` | Radon in Bq/m³ when true, pCi/L when false. |
| `co2AlertThreshold` | `1000` | ppm; HomeKit CO₂ Detected is abnormal at or above this. (Not provided over BLE by the device.) |
| `hciDeviceId` | `0` | BlueZ adapter index (`hci0`). Match other BLE plugins for shared locking. |
| `debug` | `false` | Verbose BLE logs. |
| `devices` | `[]` | Optional filter list. Empty = auto-discover nearby Airthings sensors by manufacturer data. |

### Optional device filter

```json
"devices": [
  {
    "serialNumber": "2930123456",
    "name": "Basement Wave Plus"
  },
  {
    "address": "aa:bb:cc:dd:ee:ff",
    "name": "Bedroom Wave Mini"
  }
]
```

Serial numbers come from BLE manufacturer data (same as the Airthings app / packaging).

### Sharing the adapter with other BLE plugins

Both this plugin and `@ushuz/homebridge-govee-ble` use **node-ble** (BlueZ D-Bus), so they no longer fight over exclusive raw HCI sockets. They still take a short-lived directory lock (`$TMPDIR/homebridge-ble-hci{N}.lock/`) around scan/connect so only one plugin drives the radio at a time. Set the same `hciDeviceId` on both.

## HomeKit services

See the plugin UI / accessory characteristics for temperature, humidity, CO₂, VOC, pressure, radon, battery, and air quality mappings.
