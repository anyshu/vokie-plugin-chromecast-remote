// Normalize only identifiable Chromecast report 1. Never turn an unrelated
// report into a button event by guessing its report ID.
func chromecastButtonReport(reportID: UInt32, bytes: [UInt8]) -> [UInt8]? {
    guard !bytes.isEmpty else { return nil }
    if reportID == 1 {
        // One byte is a payload, including power usage 0x01.
        return bytes.count > 1 && bytes.first == 1 ? bytes : [1] + bytes
    }
    if reportID == 0 && bytes.count > 1 && bytes.first == 1 { return bytes }
    return nil
}
