import Foundation
import IOKit
import IOKit.hidsystem

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

// Check only: do not explicitly request access or assume which parent app TCC
// attributes this helper to. Shared input can require this permission too.
func emitInputMonitoringAccess() {
    let access: String
    switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
    case kIOHIDAccessTypeGranted: access = "granted"
    case kIOHIDAccessTypeDenied: access = "denied"
    default: access = "unknown"
    }
    emit(["type": "permission", "inputMonitoring": access])
}

func emitHIDError(_ result: IOReturn, operation: String, recoverable: Bool) {
    let code = String(format: "0x%08X", UInt32(bitPattern: result))
    let reason: String
    switch result {
    case kIOReturnExclusiveAccess:
        reason = "设备存在独占访问冲突"
    case kIOReturnNotPermitted, kIOReturnNotPrivileged:
        reason = "访问被系统拒绝，请核对输入监控授权及进程权限"
    default:
        reason = "HID 操作失败"
    }
    emit([
        "type": "error", "operation": operation, "code": code,
        "recoverable": recoverable,
        "message": "\(operation): \(reason)（\(code)）" + (recoverable ? "，尝试共享模式" : "")
    ])
    emitInputMonitoringAccess()
}
