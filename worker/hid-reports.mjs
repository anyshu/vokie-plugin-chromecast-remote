// Chromecast Voice Remote HID-over-GATT input reports.
//
// All buttons share input report ID 0x01. The payload after the report ID is
// a single usage byte: 0x00 releases the last reported button; any other
// value is a new key-down. The remote never sends explicit per-key up events,
// so a key-up is synthesized whenever the usage changes or a zero arrives.
// Usage codes follow vRemoter's RemoteProfiles.chromecastButtons table.

import { buttonReport } from './remote-profile.mjs';

export const HID_INPUT_REPORT_ID = 0x01;

export const CHROMECAST_BUTTONS = {
  0x01: 'power',
  0x03: 'up',
  0x04: 'down',
  0x05: 'left',
  0x06: 'right',
  0x07: 'select', // 确认键
  0x08: 'mute',
  0x0a: 'home',
  0x0b: 'back', // 返回键
  0x0c: 'volume_up',
  0x0d: 'volume_down',
  0x0e: 'youtube',
  0x0f: 'netflix',
  0x11: 'input'
};

/**
 * Stateful parser that turns raw HID notifications into button edge events
 * with de-duplication: repeated identical usage bytes are dropped so noisy
 * BLE retransmits cannot double-fire a button.
 */
export class HidButtonParser {
  profile = 'legacy';
  #lastUsage = null;

  /**
   * @param {Uint8Array} bytes raw report notification (report ID may or may
   *        not be included as the first byte)
   * @returns {Array<{button: string|null, isDown: boolean}>} ordered edges;
   *          button is null for a release of an unknown usage
   */
  feed(bytes) {
    if (!bytes.length) return [];
    let usage;
    if (this.profile === 'a0') {
      const payload = bytes.length === 9 && bytes[0] === HID_INPUT_REPORT_ID ? bytes.subarray(1) : bytes;
      const report = buttonReport('a0', { gattHandle: 0x29, value: [...payload] });
      if (!report) return [];
      usage = { select: 7, back: 11, released: 0 }[report];
    } else {
      if (bytes[0] !== HID_INPUT_REPORT_ID) return [];
      const payload = bytes.length > 1 ? bytes.subarray(1) : bytes;
      usage = payload[0];
    }
    const events = [];

    if (usage === 0) {
      if (this.#lastUsage !== null) {
        events.push({ button: CHROMECAST_BUTTONS[this.#lastUsage] ?? null, isDown: false });
        this.#lastUsage = null;
      }
      return events;
    }

    if (this.#lastUsage === usage) return []; // duplicate key-down, deduped
    if (this.#lastUsage !== null) {
      events.push({ button: CHROMECAST_BUTTONS[this.#lastUsage] ?? null, isDown: false });
    }
    this.#lastUsage = usage;
    events.push({ button: CHROMECAST_BUTTONS[usage] ?? null, isDown: true });
    return events;
  }

  reset() {
    this.#lastUsage = null;
  }
}
