import Foundation
import IOKit
import IOKit.hid
import CoreBluetooth

// Metadata-only HID enumeration: never open/seize an input report channel.
// CoreBluetooth only reads DIS serial for the exact HID peripheral UUID. ATVV
// notifications and writes remain owned by the Host adapter.
final class IdentityBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: IOHIDManager?
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var serialCharacteristic: CBCharacteristic?
    private var identity: [String: String] = [:]
    private var pollTimer: Timer?
    private var probeTimer: Timer?
    private var captureActive = false
    private var verified = false
    private let infoService = CBUUID(string: "180A")
    private let serialUuid = CBUUID(string: "2A25")

    func start() {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [kIOHIDVendorIDKey: 0x18d1, kIOHIDProductIDKey: 0x9450] as CFDictionary)
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        self.manager = manager
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
        emit(["type": "identity_ready"])
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        disconnect()
        if let manager {
            IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        manager = nil
    }

    func command(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "capture":
            let active = message["active"] as? Bool == true
            if active == captureActive { return }
            captureActive = active
            verified = false
            if active { connect() } else { disconnect() }
        case "identity_verified":
            verified = message["verified"] as? Bool == true
            if verified { probeTimer?.invalidate(); probeTimer = nil }
            else if captureActive { connect(); scheduleProbe() }
        default: break
        }
    }

    private func refresh() {
        guard let manager else { return }
        let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? []
        var candidates: [[String: String]] = []
        for device in devices {
            func number(_ key: String) -> Int { IOHIDDeviceGetProperty(device, key as CFString) as? Int ?? 0 }
            func string(_ key: String) -> String { IOHIDDeviceGetProperty(device, key as CFString) as? String ?? "" }
            guard supportedIdentity(vendor: number(kIOHIDVendorIDKey), product: number(kIOHIDProductIDKey),
                page: number(kIOHIDPrimaryUsagePageKey), usage: number(kIOHIDPrimaryUsageKey)) else { continue }
            let value = ["deviceId": string("PhysicalDeviceUniqueID"), "modelNumber": string("ModelNumber"),
                "firmwareVersion": string("kBTFirmwareRevisionKey"), "serialNumber": string(kIOHIDSerialNumberKey),
                "deviceAddress": string("DeviceAddress")]
            if !candidates.contains(value) { candidates.append(value) }
        }
        // Keep the selected device stable while it remains present; do not jump
        // between multiple HID collections or two same-name remotes each poll.
        let next = candidates.first(where: { $0 == identity }) ??
            candidates.sorted { ($0["deviceId"] ?? "") < ($1["deviceId"] ?? "") }.first ?? [:]
        if next != identity {
            disconnect()
            identity = next
            var payload: [String: Any] = next
            payload["type"] = "identity"
            payload["connected"] = !next.isEmpty
            emit(payload)
        }
        if captureActive { connect() }
    }

    private func connect() {
        guard captureActive, identity["modelNumber"]?.trimmingCharacters(in: .whitespacesAndNewlines) == "A0",
            let id = identity["deviceId"].flatMap(UUID.init(uuidString:)),
            (identity["serialNumber"]?.utf8.count ?? 0) >= 6 else { return }
        if central == nil { central = CBCentralManager(delegate: self, queue: .main); return }
        guard let central, central.state == .poweredOn else { return }
        if let peripheral {
            if peripheral.state == .connected { scheduleProbe() }
            return
        }
        guard let candidate = central.retrievePeripherals(withIdentifiers: [id]).first else { return }
        peripheral = candidate
        candidate.delegate = self
        central.connect(candidate, options: nil)
    }

    private func disconnect() {
        probeTimer?.invalidate()
        probeTimer = nil
        serialCharacteristic = nil
        verified = false
        if let peripheral {
            peripheral.delegate = nil
            central?.cancelPeripheralConnection(peripheral)
        }
        peripheral = nil
        emit(["type": "identity_reset", "deviceId": identity["deviceId"] ?? ""])
    }

    private func scheduleProbe() {
        guard captureActive, !verified, probeTimer == nil, serialCharacteristic != nil else { return }
        // Delay the read until the Worker has processed the identity announcement.
        probeTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { [weak self] _ in self?.probe() }
    }

    private func probe() {
        probeTimer = nil
        guard captureActive, !verified, let peripheral, peripheral.state == .connected,
            let characteristic = serialCharacteristic, let serial = identity["serialNumber"] else { return }
        emit(["type": "identity_probe", "deviceId": identity["deviceId"] ?? "", "serialNumber": serial])
        peripheral.readValue(for: characteristic)
        probeTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in self?.probe() }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { connect() } else { disconnect() }
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard self.peripheral === peripheral else { return }
        peripheral.discoverServices([infoService])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard self.peripheral === peripheral else { return }
        disconnect()
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard self.peripheral === peripheral else { return }
        disconnect()
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard self.peripheral === peripheral, error == nil,
            let service = peripheral.services?.first(where: { $0.uuid == infoService }) else { return }
        peripheral.discoverCharacteristics([serialUuid], for: service)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard self.peripheral === peripheral, error == nil else { return }
        serialCharacteristic = service.characteristics?.first(where: { $0.uuid == serialUuid })
        scheduleProbe()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard self.peripheral === peripheral, characteristic === serialCharacteristic,
            error == nil, let value = characteristic.value else { return }
        emit(["type": "identity_confirm", "deviceId": identity["deviceId"] ?? "", "data": value.base64EncodedString()])
    }
}
