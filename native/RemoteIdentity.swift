import Foundation

// Keyboard on hid_mouse; Consumer Control on A0. Both require the exact VID/PID.
func supportedIdentity(vendor: Int, product: Int, page: Int, usage: Int) -> Bool {
    vendor == 0x18d1 && product == 0x9450 &&
        ((page == 1 && usage == 6) || (page == 12 && usage == 1))
}
