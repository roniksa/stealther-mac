# Stealther for Mac

A macOS tracker for nearby Wi-Fi and Bluetooth LE devices. It lists each device's ID, shows the devices on a radar at an estimated distance, keeps a permanent record, and shows how long each device has been around.

```
./run.sh          # build the scanner if needed, start the server, open http://127.0.0.1:8765
./run.sh --demo   # simulated devices in data/demo.db, no scanner or permissions needed
```

On first launch macOS asks for two permissions for **Stealther Scanner**:

- **Bluetooth**: needed to scan for BLE devices.
- **Location**: macOS only shows Wi-Fi SSIDs and BSSIDs to apps with Location access. Your position is never read or stored.

You can change both later in System Settings → Privacy & Security. Rebuilding the scanner changes its signature, so macOS may ask again.

## Install

You need macOS 12 or later and Apple's Command Line Tools, which include Swift and Python 3. If you don't have them, run `xcode-select --install` in Terminal first.

1. Download **Source code (zip)** from the [latest release](https://github.com/roniksa/stealther-mac/releases/latest) and unzip it.
2. In Terminal, go to the unzipped folder and start it:
   ```
   cd ~/Downloads/stealther-mac-1.0.1
   ./run.sh
   ```
   The first run builds `build/StealtherScanner.app` on your Mac, starts the local server and opens http://127.0.0.1:8765. Press Ctrl-C in Terminal to stop.
3. Try it without permissions first with `./run.sh --demo`.

Everything runs on your Mac. The server listens on 127.0.0.1 only, and the record lives in `data/stealther.db`.

## How it works

| Part | What it does |
|---|---|
| `scanner/main.swift` → `build/StealtherScanner.app` | A background app with no Dock icon. It runs a continuous CoreBluetooth scan (repeated adverts included) and a CoreWLAN Wi-Fi scan every 10 s, and POSTs a batch to the server every 2 s. |
| `server.py` (Python stdlib only) | Classifies devices, tracks presence sessions, stores everything in `data/stealther.db` (SQLite), and serves the UI and JSON API on 127.0.0.1 only. |
| `web/` | The radar, the device list, the detail drawer, calibration, and the map (`geo.js`). |

**Device IDs.** Wi-Fi devices use their BSSID. Bluetooth devices use the per-Mac CoreBluetooth UUID. Phones, AirPods and AirTags change their Bluetooth address about every 15 min, or about every 24 h for an AirTag away from its owner. Each change shows up as a new record. Fixed devices (headphones, keyboards, TVs, beacons, APs) keep one record.

**How long it's been around.** Sightings that are no more than `--gap` seconds apart (default 120) form one presence session.
- *Here for*: length of the current session.
- *Total seen*: all sessions added together.
- The drawer also shows first seen, the session list, and a 30-minute signal chart.

**Distance.** Uses the log-distance path-loss model: `d = 10^((P1m − RSSI) / (10·n))`.
- RSSI is the median over the last 10 s for BLE, or 40 s for Wi-Fi.
- *n* comes from the environment mode: outdoor open 2.0, outdoor urban 2.7, indoor same room 2.2, home 3.0, office 3.5, dense 4.0, or custom.
- P1m (signal strength at 1 m) is taken from the first of these that exists: your per-device calibration ("Device is 1 m away now"), an iBeacon's advertised power, the advertised Tx power minus 60 dB, or a default for the band. You can change the defaults under **Calibration**.
- The radar's uncertainty bar shows ±σ dB of signal noise. Expect real errors of 2× or more, especially through walls or bodies.

**Direction.** A single Mac antenna can't measure bearing. Each device is drawn at a fixed angle derived from its ID, so only the distance from the centre means anything.

**Trackers.** The UI flags:
- Apple Find My devices separated from their owner (AirTags, AirPods, lost devices)
- Tile
- Samsung SmartTag
- Google Find My Device tags

A banner appears when a separated tracker has been near you for over 10 minutes.

## Map: locating access points

The **Map** view shows the devices on an OpenStreetMap or Esri satellite base map. It estimates where each one is from signal readings you record at known places.

1. Carry the Mac to a place you can find on the map, such as the front of your garage. Then mark it in either of two ways:
   - Press **📍 I’m here** and click that place.
   - Press **◎** (find my location). It drops a **You** pin at the browser's best guess, with a circle showing how far off that guess might be. Drag the pin, or click the map, to the exact spot, then press **Confirm & record**. If the browser can't get a location, the pin is placed at the map centre instead.
2. Keep the Mac still while it records. The default is 2 min, which gives about 12 Wi-Fi scans; you can change it under *Record for*. **Stop here** ends a recording early.
3. Repeat at more spots. Use **3 or more that surround the area**. Spots in a straight line (for example the garage and the end of the alley) can't tell which side of the line a device is on. In that case the device is shown as *2 possible places*, joined by a dashed line, until you add a spot off the line.
4. Click a device on the map or in the list to see its card:
   - the shaded area shows where it could be;
   - the dashed outline is the likely area, about a 2-in-3 chance;
   - circles show the range each spot measured.

**Fixing mistakes.**
- Drag a numbered spot to correct its position.
- Use **Edit** to change a spot's start and end time.
- **Add past visit** tags an earlier stretch of recorded data with a place. It works as long as the scanner was running with you there and the readings are still kept (30 days by default).

**How the estimate works.** It uses the same model as the radar, `RSSI = P1m − 10·n·log10(d)`.
- For every cell of a grid around your spots, it checks how well that model explains the median signal heard at each spot. P1m is fitted per device, within ±6 dB of the default, and each spot is allowed ±6 dB of error.
- A spot where the scanner was running but never heard the device counts against cells close to that spot.
- Pick the Environment mode that fits the spots, for example *Outdoor · urban*. Walls, cars and people still shift results by tens of metres.

**What can be located.**
- Wi-Fi access points and fixed Bluetooth devices can be located.
- Phones and AirTags change their Bluetooth address, so they can't be followed from spot to spot.

**Privacy.**
- Spots are stored only in the local database.
- The base map tiles come from OpenStreetMap or Esri, and address search uses OpenStreetMap Nominatim. Those services see the area you view or the text you search for.

## iPhone app

**Stealther for iPhone** scans Bluetooth LE on the go and tags readings with GPS, so walking around is enough to locate fixed devices. iOS doesn't let apps scan Wi-Fi or Classic Bluetooth, which is what the Mac version is for. See [getstealther.com](https://getstealther.com).

**Optional sync from the iPhone app**
- Start the server with `python3 server.py --lan`. It then also listens on the local network and prints its address and a token. Enter both under Settings → Sync on the phone.
- Batches go to `/ingest` in the Mac scanner's format, and the phone's IDs show up as separate `ble:` records.
- *Also send places I stood still* posts a session's standing-still spots (≥ 20 s) to `/api/fixes` when you press Stop. Caveat: the server attributes every reading in a spot's time window to that spot, including the Mac scanner's own. So leave this off while the Mac scanner is running somewhere else.
- With `--lan`, other machines can only POST `/ingest` and `/api/fixes`, and only with the token. The web UI and the read API stay localhost-only. Without `--lan`, nothing changes. Nothing is sent anywhere except your own Mac.

## API

- `GET /api/devices?since=900`: devices seen in the last *since* seconds (`0` = all of them).
- `GET /api/device/<id>`: one device's history and sessions.
- `POST /api/device/<id>`: set `{label, p1m, watched}`.
- `GET /api/export.csv`: every device in the record as CSV.
- `GET /api/geo`: your spots and each device's median RSSI at every spot.
- `POST /api/fixes`: add a spot, `{lat, lon, t0?, t1?, dwell?}`.
- `POST /api/fix/<id>`: change a spot, `{lat, lon, t0, t1}`, or send `{stop: true}` or `{delete: true}`.

Server options: `--gap`, `--retention-days` (how long raw RSSI samples are kept, default 30), `--port`, `--db`, `--lan` (also accept the iPhone app on the local network; prints a token), `--lan-token`.

## License

MIT. See [LICENSE](LICENSE).
