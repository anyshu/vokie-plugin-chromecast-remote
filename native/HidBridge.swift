import Foundation
import IOKit
import IOKit.hid

final class HidBridge {
    private var manager: IOHIDManager?
    private var collections: [IOHIDDevice] = []
    private var seized = false
    private var fallbackPending = false

    func start(wantSeize: Bool) -> Bool {
        stop()
        if open(seize: wantSeize) { return true }
        return wantSeize && open(seize: false)
    }

    private func open(seize: Bool) -> Bool {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [
            kIOHIDVendorIDKey: 0x18D1,
            kIOHIDProductIDKey: 0x9450
        ] as CFDictionary)
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(manager, hidDeviceMatched, context)
        IOHIDManagerRegisterDeviceRemovalCallback(manager, hidDeviceRemoved, context)
        IOHIDManagerRegisterInputReportCallback(manager, hidInputReport, context)
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        self.manager = manager
        seized = seize
        // Open ALL current/future matching collections in the requested mode.
        // Never shared-open first and then try to upgrade an individual device.
        let options = seize ? kIOHIDOptionsTypeSeizeDevice : kIOHIDOptionsTypeNone
        let result = IOHIDManagerOpen(manager, IOOptionBits(options))
        guard result == kIOReturnSuccess else {
            // Close partial opens before creating a fresh manager for fallback.
            stop()
            emitHIDError(result, operation: "IOHIDManagerOpen", recoverable: seize)
            return false
        }
        emit(["type": "started", "seize": seize])
        emitConnection()
        return true
    }

    func stop() {
        guard let manager else { return }
        self.manager = nil
        fallbackPending = false
        IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        IOHIDManagerRegisterInputReportCallback(manager, nil, nil)
        IOHIDManagerRegisterDeviceMatchingCallback(manager, nil, nil)
        IOHIDManagerRegisterDeviceRemovalCallback(manager, nil, nil)
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        collections.removeAll()
        seized = false
        emitConnection()
    }

    func matched(_ device: IOHIDDevice, result: IOReturn) {
        guard let manager else { return }
        guard result == kIOReturnSuccess else {
            emitHIDError(result, operation: "device_match", recoverable: seized)
            // A newly connected collection can fail after manager open succeeds.
            // Rebuild once in shared mode, outside the current IOKit callback.
            if seized && !fallbackPending {
                fallbackPending = true
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.manager === manager else { return }
                    self.stop()
                    if !self.open(seize: false) { exit(1) }
                }
            }
            return
        }
        guard !collections.contains(where: { CFEqual($0, device) }) else { return }
        collections.append(device)
        emitCollection(device, connected: true)
        emitConnection()
    }

    func removed(_ device: IOHIDDevice) {
        guard let index = collections.firstIndex(where: { CFEqual($0, device) }) else { return }
        collections.remove(at: index)
        emitCollection(device, connected: false)
        // Removing one collection must not detach callbacks for the others.
        emitConnection()
    }

    private func emitConnection() {
        emit(["type": "device", "connected": !collections.isEmpty, "collectionCount": collections.count])
    }

    private func emitCollection(_ device: IOHIDDevice, connected: Bool) {
        var registryID: UInt64 = 0
        IORegistryEntryGetRegistryEntryID(IOHIDDeviceGetService(device), &registryID)
        emit([
            "type": "collection", "connected": connected, "registryId": String(registryID),
            "usagePage": IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? 0,
            "usage": IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsageKey as CFString) as? Int ?? 0
        ])
    }

    func report(result: IOReturn, reportID: UInt32, bytes: UnsafeMutablePointer<UInt8>, length: Int) {
        guard manager != nil, !fallbackPending else { return }
        guard result == kIOReturnSuccess else {
            emitHIDError(result, operation: "input_report", recoverable: false)
            return
        }
        guard length > 0 else { return }
        let bytes = [UInt8](UnsafeBufferPointer(start: bytes, count: length))
        emit([
            "type": "raw_report", "reportId": reportID, "length": length,
            "hex": bytes.prefix(32).map { String(format: "%02X", $0) }.joined(separator: " ")
        ])
        guard let normalized = chromecastButtonReport(reportID: reportID, bytes: bytes) else { return }
        emit(["type": "hid_report", "data": Data(normalized).base64EncodedString()])
    }
}

private func hidDeviceMatched(context: UnsafeMutableRawPointer?, result: IOReturn,
                              sender: UnsafeMutableRawPointer?, device: IOHIDDevice) {
    guard let context else { return }
    Unmanaged<HidBridge>.fromOpaque(context).takeUnretainedValue().matched(device, result: result)
}

private func hidDeviceRemoved(context: UnsafeMutableRawPointer?, result: IOReturn,
                              sender: UnsafeMutableRawPointer?, device: IOHIDDevice) {
    guard let context, result == kIOReturnSuccess else { return }
    Unmanaged<HidBridge>.fromOpaque(context).takeUnretainedValue().removed(device)
}

private func hidInputReport(context: UnsafeMutableRawPointer?, result: IOReturn,
                           sender: UnsafeMutableRawPointer?, type: IOHIDReportType,
                           reportID: UInt32, report: UnsafeMutablePointer<UInt8>, reportLength: CFIndex) {
    guard let context else { return }
    Unmanaged<HidBridge>.fromOpaque(context).takeUnretainedValue()
        .report(result: result, reportID: reportID, bytes: report, length: reportLength)
}
