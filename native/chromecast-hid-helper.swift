// JSON-line HID helper. The manager owns all matching Chromecast collections.
import Foundation
import IOKit

@main
enum ChromecastHIDHelper {
    static func main() {
        setvbuf(stdout, nil, _IONBF, 0)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--help"] {
            print("Usage: chromecast-hid-helper [--seize | --observe | --identity]\nStreams Chromecast HID reports as JSON lines; exits on stdin EOF or SIGTERM/SIGINT.")
            return
        }
        guard arguments.isEmpty || arguments == ["--seize"] || arguments == ["--observe"] || arguments == ["--identity"] else {
            emit(["type": "error", "message": "Expected --seize, --observe, --identity or --help"])
            exit(2)
        }

        let bridge = HidBridge()
        let identityBridge = IdentityBridge()
        let identityOnly = arguments == ["--identity"]
        var stdinBuffer = Data()
        // Retain signal sources until the run loop exits.
        let signalSources = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler {
                bridge.stop()
                identityBridge.stop()
                exit(0)
            }
            source.resume()
            return source
        }
        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        stdinSource.setEventHandler {
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = read(STDIN_FILENO, &bytes, bytes.count)
            if count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN) {
                bridge.stop()
                identityBridge.stop()
                exit(0)
            }
            if count > 0 && identityOnly {
                stdinBuffer.append(contentsOf: bytes.prefix(count))
                while let newline = stdinBuffer.firstIndex(of: 0x0a) {
                    let line = stdinBuffer.prefix(upTo: newline)
                    if let message = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] {
                        identityBridge.command(message)
                    }
                    stdinBuffer.removeSubrange(...newline)
                }
                if stdinBuffer.count > 65536 { stdinBuffer.removeAll() }
            }
        }
        stdinSource.resume()

        if identityOnly {
            identityBridge.start()
        } else {
            emitInputMonitoringAccess()
            guard bridge.start(wantSeize: !arguments.contains("--observe")) else { exit(1) }
        }
        withExtendedLifetime((signalSources, stdinSource, bridge, identityBridge)) {
            RunLoop.main.run()
        }
    }
}
