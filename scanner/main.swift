// StealtherScanner — headless macOS agent that scans Wi-Fi (CoreWLAN) and
// Bluetooth LE (CoreBluetooth) and POSTs batches of readings to the local
// Stealther server. It lives in an .app bundle so macOS can grant it the
// Location (needed to see SSID/BSSID) and Bluetooth permissions.

import AppKit
import CoreBluetooth
import CoreLocation
import CoreWLAN
import Foundation

let args = CommandLine.arguments
func argValue(_ name: String, _ def: String) -> String {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return def
}

let ingestURL = URL(string: argValue("--url", "http://127.0.0.1:8765/ingest"))!
let postInterval = Double(argValue("--post", "2")) ?? 2
let wifiInterval = Double(argValue("--wifi", "10")) ?? 10

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

func bandName(_ b: CWChannelBand) -> String {
    switch b {
    case .band2GHz: return "2.4GHz"
    case .band5GHz: return "5GHz"
    case .band6GHz: return "6GHz"
    default: return "unknown"
    }
}

func widthName(_ w: CWChannelWidth) -> String {
    switch w {
    case .width20MHz: return "20MHz"
    case .width40MHz: return "40MHz"
    case .width80MHz: return "80MHz"
    case .width160MHz: return "160MHz"
    default: return "unknown"
    }
}

func securityName(_ n: CWNetwork) -> String {
    let checks: [(CWSecurity, String)] = [
        (.wpa3Enterprise, "WPA3 Enterprise"), (.wpa3Personal, "WPA3 Personal"),
        (.wpa3Transition, "WPA2/WPA3 Personal"), (.wpa2Enterprise, "WPA2 Enterprise"),
        (.wpa2Personal, "WPA2 Personal"), (.wpaEnterprise, "WPA Enterprise"),
        (.wpaPersonal, "WPA Personal"), (.OWE, "OWE"), (.oweTransition, "OWE Transition"),
        (.dynamicWEP, "Dynamic WEP"), (.WEP, "WEP"), (.none, "Open"),
    ]
    for (s, name) in checks where n.supportsSecurity(s) { return name }
    return "Unknown"
}

func authName(_ s: CLAuthorizationStatus) -> String {
    switch s {
    case .authorizedAlways: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return s.rawValue == 4 ? "authorized" : "unknown"  // 4 = whenInUse
    }
}

final class Scanner: NSObject, CBCentralManagerDelegate, CLLocationManagerDelegate {
    private let lock = NSLock()
    private var ble: [String: [String: Any]] = [:]
    private var wifi: [[String: Any]]?
    private var wifiError: String?
    private var wifiIface = ""
    private var btState = "unknown"
    private var locState = "unknown"
    private var central: CBCentralManager!
    private let location = CLLocationManager()
    private let bleQueue = DispatchQueue(label: "stealther.ble")
    private let wifiQueue = DispatchQueue(label: "stealther.wifi")

    func start() {
        location.delegate = self
        locState = authName(location.authorizationStatus)
        location.requestWhenInUseAuthorization()
        location.startUpdatingLocation()  // triggers the permission prompt on macOS
        central = CBCentralManager(delegate: self, queue: bleQueue)
        wifiQueue.async { self.wifiLoop() }
        Timer.scheduledTimer(withTimeInterval: postInterval, repeats: true) { [weak self] _ in
            self?.post()
        }
    }

    // MARK: Location (only needed so CoreWLAN reveals SSID/BSSID)

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        lock.lock(); locState = authName(manager.authorizationStatus); lock.unlock()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        manager.stopUpdatingLocation()  // we never use the position itself
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    // MARK: Bluetooth LE

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        let s: String
        switch c.state {
        case .poweredOn: s = "poweredOn"
        case .poweredOff: s = "poweredOff"
        case .unauthorized: s = "unauthorized"
        case .unsupported: s = "unsupported"
        case .resetting: s = "resetting"
        default: s = "unknown"
        }
        lock.lock(); btState = s; lock.unlock()
        if c.state == .poweredOn {
            c.scanForPeripherals(withServices: nil,
                                 options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData adv: [String: Any], rssi RSSI: NSNumber) {
        let r = RSSI.intValue
        if r >= 20 || r <= -127 { return }  // 127 = "not available"
        let id = p.identifier.uuidString
        lock.lock(); defer { lock.unlock() }
        var rec = ble[id] ?? ["id": id, "samples": [Int]()]
        var samples = rec["samples"] as? [Int] ?? []
        samples.append(r)
        rec["samples"] = samples
        if let n = (adv[CBAdvertisementDataLocalNameKey] as? String) ?? p.name, !n.isEmpty {
            rec["name"] = n
        }
        if let tx = adv[CBAdvertisementDataTxPowerLevelKey] as? NSNumber { rec["tx"] = tx.intValue }
        if let m = adv[CBAdvertisementDataManufacturerDataKey] as? Data { rec["mfg"] = hex(m) }
        var svcs: [String] = []
        for key in [CBAdvertisementDataServiceUUIDsKey, CBAdvertisementDataOverflowServiceUUIDsKey,
                    CBAdvertisementDataSolicitedServiceUUIDsKey] {
            if let u = adv[key] as? [CBUUID] { svcs += u.map { $0.uuidString } }
        }
        if !svcs.isEmpty { rec["services"] = Array(Set(svcs)) }
        if let sd = adv[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
            var o: [String: String] = [:]
            for (k, v) in sd { o[k.uuidString] = hex(v) }
            rec["service_data"] = o
        }
        if let conn = adv[CBAdvertisementDataIsConnectable] as? NSNumber { rec["connectable"] = conn.boolValue }
        ble[id] = rec
    }

    // MARK: Wi-Fi

    private func wifiLoop() {
        while true {
            scanWiFiOnce()
            Thread.sleep(forTimeInterval: wifiInterval)
        }
    }

    private func describe(_ n: CWNetwork) -> [String: Any] {
        var d: [String: Any] = [
            "rssi": n.rssiValue, "noise": n.noiseMeasurement,
            "beacon": n.beaconInterval, "ibss": n.ibss, "security": securityName(n),
        ]
        if let s = n.ssid { d["ssid"] = s }
        if let b = n.bssid { d["bssid"] = b.lowercased() }
        if let c = n.wlanChannel {
            d["channel"] = c.channelNumber
            d["band"] = bandName(c.channelBand)
            d["width"] = widthName(c.channelWidth)
        }
        if let cc = n.countryCode { d["country"] = cc }
        return d
    }

    private func scanWiFiOnce() {
        guard let iface = CWWiFiClient.shared().interface() else {
            lock.lock(); wifiError = "No Wi-Fi interface"; lock.unlock()
            return
        }
        var out: [[String: Any]] = []
        var err: String?
        do {
            let nets = try iface.scanForNetworks(withSSID: nil, includeHidden: true)
            out = nets.map { describe($0) }
        } catch {
            err = error.localizedDescription
            if let cached = iface.cachedScanResults() { out = cached.map { describe($0) } }
        }
        // Make sure the network we're associated with is present and marked.
        let curBSSID = iface.bssid()?.lowercased()
        let curRSSI = iface.rssiValue()
        if curRSSI != 0 {
            var matched = false
            if let b = curBSSID {
                for i in out.indices where (out[i]["bssid"] as? String) == b {
                    out[i]["connected"] = true; matched = true
                }
            }
            if !matched {
                var d: [String: Any] = ["rssi": curRSSI, "noise": iface.noiseMeasurement(), "connected": true]
                if let s = iface.ssid() { d["ssid"] = s }
                if let b = curBSSID { d["bssid"] = b }
                if let c = iface.wlanChannel() {
                    d["channel"] = c.channelNumber
                    d["band"] = bandName(c.channelBand)
                    d["width"] = widthName(c.channelWidth)
                }
                out.append(d)
            }
        }
        lock.lock()
        wifi = out
        wifiError = err
        wifiIface = iface.interfaceName ?? ""
        lock.unlock()
    }

    // MARK: Upload

    private func post() {
        lock.lock()
        let bleOut = Array(ble.values)
        ble.removeAll()
        let wifiOut = wifi
        wifi = nil
        var status: [String: Any] = ["bluetooth": btState, "location": locState,
                                     "wifi_iface": wifiIface, "version": "1.0"]
        if let e = wifiError { status["wifi_error"] = e }
        lock.unlock()

        var payload: [String: Any] = ["ble": bleOut, "status": status]
        if let w = wifiOut { payload["wifi"] = w }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var req = URLRequest(url: ingestURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let scanner = Scanner()
scanner.start()
NSApp.activate(ignoringOtherApps: true)
app.run()
