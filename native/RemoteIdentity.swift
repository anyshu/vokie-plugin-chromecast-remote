import Foundation

// Keyboard on hid_mouse; Consumer Control on A0. Both require the exact VID/PID.
func supportedIdentity(vendor: Int, product: Int, page: Int, usage: Int) -> Bool {
    vendor == 0x18d1 && product == 0x9450 &&
        ((page == 1 && usage == 6) || (page == 12 && usage == 1))
}

func remoteIdentitySelectionPriority(modelNumber: String?) -> Int {
    modelNumber?.trimmingCharacters(in: .whitespacesAndNewlines) == "A0" ? 1 : 0
}

// Keep the current device stable unless a higher-priority A0 is available.
// Ties use the opaque peripheral UUID only for deterministic first selection.
func preferredRemoteIdentity(
    candidates: [[String: String]],
    current: [String: String]
) -> [String: String] {
    guard !candidates.isEmpty else { return [:] }
    let preferred = candidates.sorted { left, right in
        let leftPriority = remoteIdentitySelectionPriority(modelNumber: left["modelNumber"])
        let rightPriority = remoteIdentitySelectionPriority(modelNumber: right["modelNumber"])
        if leftPriority != rightPriority { return leftPriority > rightPriority }
        return (left["deviceId"] ?? "") < (right["deviceId"] ?? "")
    }.first!
    if let existing = candidates.first(where: { $0 == current }),
       remoteIdentitySelectionPriority(modelNumber: existing["modelNumber"]) >=
         remoteIdentitySelectionPriority(modelNumber: preferred["modelNumber"])
    {
        return existing
    }
    return preferred
}
