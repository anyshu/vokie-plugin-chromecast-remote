// chromecast-hid-helper — streams HID input reports of the Google Chromecast
// Voice Remote (VID 0x18D1 / PID 0x9450) as JSON lines on stdout.
//
//   {"type":"hid_report","data":"<base64 report, report ID included>"}
//   {"type":"device","connected":true|false}
//   {"type":"started","seize":true|false}
//   {"type":"error","message":"..."}
//
// Arguments:
//   --observe   never try to seize; native macOS key events keep firing
//
// Report reading follows the same proven pattern as Vokie's Xiaomi remote
// helper: the manager is opened passively for device discovery, then each
// matched device is opened individually (IOHIDDeviceOpen) and the input
// report callback is registered at the DEVICE level with a pre-allocated
// buffer. A non-seized device-level open receives input reports alongside
// the system HID stack without any TCC permission.
//
// When --seize is allowed (default, requires the spawning app to hold Input
// Monitoring / Accessibility), the device is opened exclusively so the
// remote's native key events are suppressed; on kIOReturnExclusiveAccess the
// helper falls back to the non-seized open automatically.
//
// Exits cleanly on SIGTERM/SIGINT and when stdin closes (parent died).

import Foundation
import IOKit
import IOKit.hid

setvbuf(stdout, nil, _IONBF, 0)

private let vendorID: UInt32 = 0x18D1
private let productID: UInt32 = 0x9450
private let reportBufferSize = 128

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

final class HidBridge {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var deviceSeized = false
    private var wantSeize = true
    private let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: reportBufferSize)

    deinit {
        reportBuffer.deallocate()
    }

    func start(wantSeize: Bool) -> Bool {
        self.wantSeize = wantSeize
        stop()
        let manager = IOHIDManagerCreate(
            kCFAllocatorDefault,
            IOOptionBits(kIOHIDOptionsTypeNone)
        )
        IOHIDManagerSetDeviceMatching(
            manager,
            [
                kIOHIDVendorIDKey: vendorID,
                kIOHIDProductIDKey: productID
            ] as CFDictionary
        )

        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(manager, hidDeviceMatched, context)
        IOHIDManagerRegisterDeviceRemovalCallback(manager, hidDeviceRemoved, context)
        IOHIDManagerScheduleWithRunLoop(
            manager,
            CFRunLoopGetMain(),
            CFRunLoopMode.commonModes.rawValue
        )
        // The manager itself stays passive (no seize): it only discovers
        // devices; each device is opened explicitly in attach(_:).
        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else {
            emit([
                "type": "error",
                "message": String(
                    format: "IOHIDManagerOpen failed: 0x%08X",
                    UInt32(bitPattern: result)
                )
            ])
            IOHIDManagerUnscheduleFromRunLoop(
                manager,
                CFRunLoopGetMain(),
                CFRunLoopMode.commonModes.rawValue
            )
            return false
        }
        self.manager = manager
        return true
    }

    func stop() {
        detach()
        guard let manager else { return }
        IOHIDManagerUnscheduleFromRunLoop(
            manager,
            CFRunLoopGetMain(),
            CFRunLoopMode.commonModes.rawValue
        )
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = nil
    }

    /// Open a matched device and register the device-level input report
    /// callback. Tries an exclusive (seize) open first when suppression was
    /// requested, then falls back to a plain open.
    func attach(_ device: IOHIDDevice) {
        if let current = self.device, current == device { return }
        detach()

        var openResult: IOReturn = kIOReturnSuccess
        deviceSeized = false
        if wantSeize {
            openResult = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
            if openResult == kIOReturnSuccess {
                deviceSeized = true
            } else {
                emit([
                    "type": "error",
                    "message": String(
                        format: "seize denied (0x%08X), falling back to shared open",
                        UInt32(bitPattern: openResult)
                    )
                ])
                openResult = kIOReturnSuccess
            }
        }
        if !deviceSeized {
            openResult = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        guard openResult == kIOReturnSuccess else {
            emit([
                "type": "error",
                "message": String(
                    format: "IOHIDDeviceOpen failed: 0x%08X",
                    UInt32(bitPattern: openResult)
                )
            ])
            return
        }

        self.device = device
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(
            device,
            reportBuffer,
            reportBufferSize,
            hidInputReport,
            context
        )
        emit(["type": "started", "seize": deviceSeized])
        emit(["type": "device", "connected": true])
    }

    func detach() {
        guard let device else { return }
        IOHIDDeviceRegisterInputReportCallback(
            device,
            reportBuffer,
            reportBufferSize,
            nil,
            nil
        )
        IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
        self.device = nil
        deviceSeized = false
    }

    func handleReport(reportID: UInt32, report: UnsafeMutablePointer<UInt8>, length: Int) {
        guard length > 0 else { return }
        var bytes = [UInt8](UnsafeBufferPointer(start: report, count: length))
        // The report buffer may or may not include the report ID as its first
        // byte; normalize so the wire form always starts with the report ID.
        let id = UInt8(truncatingIfNeeded: reportID)
        if bytes.first != id {
            bytes.insert(id, at: 0)
        }
        emit([
            "type": "hid_report",
            "data": Data(bytes).base64EncodedString()
        ])
    }
}

private func hidDeviceMatched(
    context: UnsafeMutableRawPointer?,
    result: IOReturn,
    sender: UnsafeMutableRawPointer?,
    device: IOHIDDevice
) {
    guard result == kIOReturnSuccess, let context else { return }
    Unmanaged<HidBridge>
        .fromOpaque(context)
        .takeUnretainedValue()
        .attach(device)
}

private func hidDeviceRemoved(
    context: UnsafeMutableRawPointer?,
    result: IOReturn,
    sender: UnsafeMutableRawPointer?,
    device: IOHIDDevice
) {
    guard result == kIOReturnSuccess, let context else { return }
    let bridge = Unmanaged<HidBridge>.fromOpaque(context).takeUnretainedValue()
    bridge.detach()
    emit(["type": "device", "connected": false])
}

private func hidInputReport(
    context: UnsafeMutableRawPointer?,
    result: IOReturn,
    sender: UnsafeMutableRawPointer?,
    type: IOHIDReportType,
    reportID: UInt32,
    report: UnsafeMutablePointer<UInt8>,
    reportLength: CFIndex
) {
    guard result == kIOReturnSuccess, let context else { return }
    Unmanaged<HidBridge>
        .fromOpaque(context)
        .takeUnretainedValue()
        .handleReport(reportID: reportID, report: report, length: Int(reportLength))
}

let arguments = CommandLine.arguments
let wantSeize = !arguments.contains("--observe")
let bridge = HidBridge()

// SIGTERM / SIGINT: release the device and exit.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
for code in [SIGTERM, SIGINT] {
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler {
        source.cancel()
        bridge.stop()
        exit(0)
    }
    source.resume()
}

// stdin EOF: the spawning worker died without killing us.
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
    var byte: UInt8 = 0
    let readCount = read(STDIN_FILENO, &byte, 1)
    if readCount <= 0 {
        stdinSource.cancel()
        bridge.stop()
        exit(0)
    }
}
stdinSource.resume()

guard bridge.start(wantSeize: wantSeize) else {
    exit(1)
}
RunLoop.main.run()
