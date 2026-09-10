// JSON-line HID helper. The manager owns all matching Chromecast collections.
import Foundation
import IOKit

@main
enum ChromecastHIDHelper {
    static func main() {
        setvbuf(stdout, nil, _IONBF, 0)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--help"] {
            print("Usage: chromecast-hid-helper [--seize | --observe]\nStreams Chromecast HID reports as JSON lines; exits on stdin EOF or SIGTERM/SIGINT.")
            return
        }
        guard arguments.isEmpty || arguments == ["--seize"] || arguments == ["--observe"] else {
            emit(["type": "error", "message": "Expected --seize, --observe or --help"])
            exit(2)
        }

        let bridge = HidBridge()
        // Retain signal sources until the run loop exits.
        let signalSources = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler {
                bridge.stop()
                exit(0)
            }
            source.resume()
            return source
        }
        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        stdinSource.setEventHandler {
            var byte: UInt8 = 0
            let count = read(STDIN_FILENO, &byte, 1)
            if count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN) {
                bridge.stop()
                exit(0)
            }
        }
        stdinSource.resume()

        emitInputMonitoringAccess()
        guard bridge.start(wantSeize: !arguments.contains("--observe")) else { exit(1) }
        withExtendedLifetime((signalSources, stdinSource, bridge)) {
            RunLoop.main.run()
        }
    }
}
