import { HidHelperSource } from './hid-helper-source.mjs';

// Separate process from the optional seized HID report reader: identity lookup
// must also run when HCI is the sole button source and needs no input monitoring.
export class RemoteIdentitySource {
  constructor({ helperPath, onDevice, onMessage, onError }) {
    this.device = null;
    this.captureActive = false;
    this.source = new HidHelperSource({
      helperPath,
      buildArgs: () => ['--identity'],
      onInfo: message => {
        if (message.type === 'identity') {
          this.device = message.connected ? message : null;
          onDevice(this.device);
        } else if (message.type === 'identity_ready') {
          this.setCapture(this.captureActive);
        } else if (message.type.startsWith('identity_')) {
          onMessage(message);
        }
      },
      onStatus: info => {
        if (!info.running && this.device) {
          this.device = null;
          onDevice(null);
        }
        if (info.error) onError?.(info.error);
      }
    });
  }
  start() { return this.source.start(); }
  stop() { this.captureActive = false; this.source.stop(); }
  setCapture(active) {
    this.captureActive = active;
    this.source.send({ type: 'capture', active });
  }
  setVerified(verified) { this.source.send({ type: 'identity_verified', verified }); }
}
