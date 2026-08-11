# @ushuz/homebridge-airthings-ble

Homebridge plugin for [Airthings](https://www.airthings.com/) air quality monitors over **Bluetooth LE**.

Sensor protocol is ported from the official [Airthings BLE library](https://github.com/Airthings/airthings-ble) used by Home Assistant.

BLE stack: [`@stoprocent/noble`](https://www.npmjs.com/package/@stoprocent/noble) (includes **armv6** prebuilds for classic Pi Zero W via `@stoprocent/bluetooth-hci-socket`).

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
| OS | Linux (Raspberry Pi), macOS |

### Raspberry Pi / Linux Bluetooth

```bash
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev
sudo systemctl enable --now bluetooth
sudo usermod -aG bluetooth homebridge   # or the user that runs homebridge
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

Reboot (or re-login) so group membership applies.

Native HCI bindings usually install from **prebuilt** binaries (including **armv6l** / Pi Zero W). Only if that fails:

```bash
sudo apt-get install -y build-essential python3
```

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
| `debug` | `false` | Verbose BLE logs. |
| `devices` | `[]` | Optional filter list. Empty = auto-discover all nearby Airthings sensors. |

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

Serial numbers come from BLE manufacturer data (same as the Airthings app / packaging). On macOS, prefer serial over address (addresses are often UUIDs).

## HomeKit services

Each device is one accessory. Services are created from sensors the device reports:

| Sensor | HomeKit |
| --- | --- |
| Temperature | Temperature Sensor |
| Humidity | Humidity Sensor |
| CO₂ | Carbon Dioxide Sensor — **Level (ppm)** + **Detected** (alert) |
| Battery | Battery |
| Illuminance / lux | Light Sensor |
| CO₂ (ppm), VOC, radon, pressure | Air Quality Sensor (+ custom characteristics) |

CO₂ **Level** is the ppm reading. **Detected** flips abnormal when ppm ≥ `co2AlertThreshold` (Homebridge config; devices do not expose a threshold over BLE). Use Level for charts and Detected for HomeKit automations/alerts.

Radon short/long-term averages use custom characteristics on the Air Quality service (HomeKit has no native radon type). Overall Air Quality is derived from radon level thresholds from the official SDK (good &lt; 100, fair &lt; 150, poor ≥ 150 Bq/m³), with CO₂/VOC fallbacks.

## How it works

1. Scans for BLE advertisements with Airthings company ID `0x0334`.
2. Connects to each device (serialized — one connection at a time for single-adapter Pis).
3. Reads GATT characteristics / command notify paths matching [airthings-ble](https://github.com/Airthings/airthings-ble).
4. Updates HomeKit characteristics, then disconnects until the next interval.

## Development

```bash
git clone https://github.com/ushuz/homebridge-airthings-ble.git
cd homebridge-airthings-ble
npm install
npm test
npm run build
```

## License

MIT

Protocol reference: [Airthings/airthings-ble](https://github.com/Airthings/airthings-ble) (MIT).
