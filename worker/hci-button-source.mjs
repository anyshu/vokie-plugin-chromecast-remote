// Button source: the Vokie privileged HCI capture daemon (macOS).
//
// Why this exists: on macOS 26.5 every button path a plugin process can reach
// directly is blocked (see spec/hid-macos-limitations.md). The remote's
// buttons are ATT Handle-Value Notifications (GATT handle 0x002B) that it
// sends over the link owned by the system HID stack; macOS hides the HID
// service from GATT and holds the report channel exclusively, so neither the
// GATT 2A4D subscription nor the IOKit helper ever sees them. The only
// user-space observation point left is the Bluetooth HCI layer: the root
// daemon installed by the Vokie device lab (/var/run/com.vokie.hci.sock,
// protocol `vokie.appleTvRemote.hci` v2) runs PacketLogger and forwards the
// nhdr stream; buttons appear there as raw ATT notifications. This mirrors
// the app-side GoogleTvRemoteHelper (same socket, same protocol, same byte
// semantics, field-tested 2026-09-11..13).
//
//   request  : {"id","protocol":"vokie.appleTvRemote.hci","command":
//              "startCapture"|"stopCapture","requiredVersion":"2",
//              "caller":{"pid","uid"},"captureId","remoteDeviceId":null}
//   response : {"type":"captureStarted"|"captureStopped"|
//              "captureUnavailable"|"error", ...}
//              {"type":"nhdr","captureId","line":"<PacketLogger nhdr line>"}
//
// Button values on handle 0x002B: `41 00` select down, `24 02` back down,
// `00 00` release; other values (volume, d-pad, …) are ignored.
//
// The daemon allows a single capture system-wide (the Apple TV Remote mic and
// the app's own Google TV helper compete for the same slot): while another
// capture is active it answers `captureUnavailable`, which this source keeps
// retrying (the failure is *not* definitive). Definitive failures (socket
// missing, version mismatch, PacketLogger missing, …) are reported with
// `definitive: true` so `auto` mode can fall back to the IOKit helper.
//
// Starting/stopping a capture reloads bluetoothd (one global Bluetooth
// flap); failed attempts do not. The daemon also stops the capture when the
// connection drops, so simply closing the socket is a clean stop.

import { createConnection } from 'node:net';

export const HCI_PROTOCOL = 'vokie.appleTvRemote.hci';
export const HCI_REQUIRED_VERSION = '2';
export const DEFAULT_HCI_SOCKET_PATH = '/var/run/com.vokie.hci.sock';

export const REMOTE_DEVICE_NAME = 'Chromecast Remote';
export const BUTTON_GATT_HANDLE = 0x002b;

const SELECT_DOWN_VALUE = Uint8Array.of(0x41, 0x00); // 确认键按下
const BACK_DOWN_VALUE = Uint8Array.of(0x24, 0x02); // 返回键按下
const BUTTON_UP_VALUE = Uint8Array.of(0x00, 0x00); // 松开

const L2CAP_ATT_CID = 0x0004;
const ATT_HANDLE_VALUE_NOTIFICATION = 0x1b;

const CONNECT_TIMEOUT_MS = 800;
const RETRY_MS = 5000;
const MAX_IGNORED_DEBUG = 20;

function valuesEqual(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Parse one PacketLogger nhdr line into an ATT Handle-Value Notification.
 *
 * Line shape: `<month> <day> <time> <device name or address…> <0xconn-handle>
 * RECV <hex bytes of the ACL packet…>`. Tokenization matches the app-side
 * helper (non-empty space/tab-separated tokens); the device-name field is
 * tokens[3 .. handleToken) and must equal the remote's Bluetooth name.
 *
 * @param {string} line
 * @param {string} [deviceName]
 * @returns {{gattHandle: number, value: number[]} | null}
 */
export function parsePacketLoggerLine(line, deviceName = REMOTE_DEVICE_NAME) {
  if (typeof line !== 'string' || !line) return null;
  const tokens = line.split(/[ \t]+/).filter((token) => token.length > 0);
  const recvIndex = tokens.findIndex((token) => token.toUpperCase() === 'RECV');
  if (recvIndex < 5) return null;
  const handleTokenIndex = recvIndex - 1;
  const name = tokens.slice(3, handleTokenIndex).join(' ');
  if (name.toLowerCase() !== deviceName.toLowerCase()) return null;

  const bytes = [];
  for (const token of tokens.slice(recvIndex + 1)) {
    const cleaned = token.endsWith(',') || token.endsWith(':') ? token.slice(0, -1) : token;
    if (cleaned.length !== 2) continue;
    const value = Number.parseInt(cleaned, 16);
    if (Number.isNaN(value)) continue;
    bytes.push(value);
  }
  return parseAclBytes(bytes);
}

/**
 * ACL → L2CAP → ATT Handle-Value Notification. Layout: [handle+PB+BC (2 LE)]
 * [ACL data length (2 LE)] [L2CAP length (2 LE)] [CID (2 LE)] [ATT opcode]
 * [GATT handle (2 LE)] [value…]. Only complete/first packets (PB=2) are
 * accepted, matching the app-side parser.
 *
 * @param {number[]} bytes
 * @returns {{gattHandle: number, value: number[]} | null}
 */
export function parseAclBytes(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 11) return null;
  const handlePB = bytes[0] | (bytes[1] << 8);
  if (((handlePB >> 12) & 0x3) !== 2) return null;
  const l2capLength = bytes[4] | (bytes[5] << 8);
  const cid = bytes[6] | (bytes[7] << 8);
  if (cid !== L2CAP_ATT_CID || bytes[8] !== ATT_HANDLE_VALUE_NOTIFICATION) return null;
  const gattHandle = bytes[9] | (bytes[10] << 8);
  const valueEnd = Math.min(bytes.length, 11 + Math.max(0, l2capLength - 3));
  return { gattHandle, value: bytes.slice(11, valueEnd) };
}

/**
 * Stateful button decoder for the remote's ATT notifications: turns values on
 * GATT handle 0x002B into `{button, isDown}` edges (same shape as the HID
 * report parser), de-duplicating held keys and synthesizing releases.
 */
export class HciButtonValueParser {
  #selectPressed = false;
  #backPressed = false;
  #ignoredCount = 0;

  /** @returns {Array<{button: 'select'|'back', isDown: boolean}>} */
  feed({ gattHandle, value }) {
    if (gattHandle !== BUTTON_GATT_HANDLE) return [];
    if (!Array.isArray(value) || value.length !== 2) return [];

    if (valuesEqual(value, SELECT_DOWN_VALUE)) {
      if (this.#selectPressed) return [];
      this.#selectPressed = true;
      return [{ button: 'select', isDown: true }];
    }
    if (valuesEqual(value, BACK_DOWN_VALUE)) {
      if (this.#backPressed) return [];
      this.#backPressed = true;
      return [{ button: 'back', isDown: true }];
    }
    if (valuesEqual(value, BUTTON_UP_VALUE)) {
      const edges = [];
      if (this.#selectPressed) {
        this.#selectPressed = false;
        edges.push({ button: 'select', isDown: false });
      }
      if (this.#backPressed) {
        this.#backPressed = false;
        edges.push({ button: 'back', isDown: false });
      }
      return edges;
    }
    // Other physical keys (volume, d-pad, custom keys…): ignore; log bounded.
    this.#ignoredCount += 1;
    if (this.#ignoredCount <= MAX_IGNORED_DEBUG) {
      console.error(`[cast-hci] ignored button value: ${value.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`);
    }
    return [];
  }

  reset() {
    this.#selectPressed = false;
    this.#backPressed = false;
    this.#ignoredCount = 0;
  }
}

function classifyDefinitive(error) {
  // "another capture is active" is contention, not a broken installation:
  // keep retrying quietly and never fall back to IOKit for it.
  return !String(error).includes('another capture is active');
}

/**
 * Owns the daemon connection lifecycle: connect → startCapture → parse nhdr
 * lines → button edges. Retries every 5 s while started (both for contention
 * and for hard failures); `definitive` in the status events lets `auto` mode
 * decide to fall back to the IOKit helper instead of retrying forever.
 */
export class HciButtonSource {
  /**
   * @param {object} options
   * @param {string} [options.socketPath]
   * @param {(edge: {button: string, isDown: boolean}) => void} [options.onEdge]
   * @param {(info: {phase: 'connecting'|'capturing'|'retrying'|'stopped',
   *          error?: string|null, definitive?: boolean, retryInMs?: number|null}) => void} [options.onStatus]
   * @param {object} [options.clock] injectable {setTimer(fn, ms), clearTimer(handle)}
   */
  constructor({ socketPath, onEdge, onStatus, clock } = {}) {
    this.#socketPath = socketPath ?? DEFAULT_HCI_SOCKET_PATH;
    this.#onEdge = onEdge ?? (() => {});
    this.#onStatus = onStatus ?? (() => {});
    this.#clock = clock ?? {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle)
    };
    this.#parser = new HciButtonValueParser();
  }

  #socketPath;
  #onEdge;
  #onStatus;
  #clock;
  #parser;
  #started = false;
  #socket = null;
  #lineBuffer = '';
  #captureActive = false;
  #requestCounter = 0;
  #retryTimer = null;
  #connectTimer = null;
  #lastError = null;

  get active() {
    return this.#captureActive;
  }

  get started() {
    return this.#started;
  }

  get lastError() {
    return this.#lastError;
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#connect();
  }

  stop() {
    this.#started = false;
    this.#clearTimers();
    this.#closeSocket();
    this.#status({ phase: 'stopped', error: null });
  }

  #status(info) {
    if (info.error !== undefined) this.#lastError = info.error;
    try {
      this.#onStatus(info);
    } catch {
      // listener errors must not kill the pump
    }
  }

  #clearTimers() {
    if (this.#retryTimer) {
      this.#clock.clearTimer(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#connectTimer) {
      this.#clock.clearTimer(this.#connectTimer);
      this.#connectTimer = null;
    }
  }

  #scheduleRetry(error) {
    if (!this.#started || this.#retryTimer) return;
    this.#status({ phase: 'retrying', error, definitive: classifyDefinitive(error), retryInMs: RETRY_MS });
    // A definitive failure reported through onStatus may have stopped us
    // (auto mode falls back to the IOKit helper); don't arm a dead timer.
    if (!this.#started) return;
    this.#retryTimer = this.#clock.setTimer(() => {
      this.#retryTimer = null;
      if (this.#started) this.#connect();
    }, RETRY_MS);
  }

  #closeSocket() {
    const socket = this.#socket;
    this.#socket = null;
    this.#captureActive = false;
    this.#lineBuffer = '';
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  #connect() {
    if (!this.#started) return;
    this.#closeSocket();
    this.#status({ phase: 'connecting', error: this.#lastError });

    let settled = false;
    const socket = createConnection({ path: this.#socketPath }, () => {
      if (!this.#started || settled) return socket.destroy();
      settled = true;
      if (this.#connectTimer) {
        this.#clock.clearTimer(this.#connectTimer);
        this.#connectTimer = null;
      }
      this.#lineBuffer = '';
      this.#sendRequest('startCapture');
    });
    this.#socket = socket;

    this.#connectTimer = this.#clock.setTimer(() => {
      this.#connectTimer = null;
      if (settled) return;
      settled = true;
      socket.destroy();
      if (this.#socket === socket) {
        this.#scheduleRetry(`HCI 守护进程连接超时（${this.#socketPath}）`);
      }
    }, CONNECT_TIMEOUT_MS);

    socket.on('error', (error) => {
      if (this.#socket !== socket) return;
      if (!settled) {
        settled = true;
        if (this.#connectTimer) {
          this.#clock.clearTimer(this.#connectTimer);
          this.#connectTimer = null;
        }
      }
      this.#scheduleRetry(`HCI 守护进程不可用（${this.#socketPath}）：${error.message}`);
      this.#closeSocket();
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      const wasActive = this.#captureActive;
      this.#closeSocket();
      if (this.#started) {
        // The daemon stops our capture when the connection drops; reconnect
        // and request it again. Before the first captureStarted this is just
        // a failed handshake attempt.
        this.#scheduleRetry(wasActive ? 'HCI 抓包连接中断，等待重连' : this.#lastError ?? 'HCI 守护进程连接关闭');
      }
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (this.#socket !== socket || !this.#started) return;
      this.#lineBuffer += chunk;
      for (;;) {
        const newline = this.#lineBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.#lineBuffer.slice(0, newline).trim();
        this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
        if (line) this.#handleLine(line);
      }
    });
  }

  #sendRequest(command) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return;
    this.#requestCounter += 1;
    const request = {
      id: `chromecast-plugin-${process.pid}-${this.#requestCounter}`,
      protocol: HCI_PROTOCOL,
      command,
      requiredVersion: HCI_REQUIRED_VERSION,
      caller: {
        pid: process.pid,
        uid: typeof process.getuid === 'function' ? process.getuid() : null
      },
      captureId: `chromecast-plugin-${process.pid}`,
      remoteDeviceId: null
    };
    socket.write(JSON.stringify(request) + '\n');
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message?.type) {
      case 'captureStarted':
        if (this.#captureActive) return;
        this.#captureActive = true;
        this.#parser.reset();
        this.#status({ phase: 'capturing', error: null });
        console.error(`[cast-hci] capture started (${this.#socketPath})`);
        return;
      case 'captureStopped':
        // Unexpected mid-stream stop: the daemon ends the capture but keeps
        // the socket open, so ask for it again.
        this.#captureActive = false;
        this.#parser.reset();
        this.#scheduleRetry('HCI 抓包被停止，重新请求');
        this.#sendRequest('startCapture');
        return;
      case 'captureUnavailable':
      case 'error': {
        const error = String(message.message ?? (message.type === 'error' ? 'HCI 守护进程错误' : 'HCI 抓包不可用'));
        this.#captureActive = false;
        console.error(`[cast-hci] ${message.type}: ${error}`);
        this.#scheduleRetry(error);
        return;
      }
      case 'nhdr':
        if (!this.#captureActive || typeof message.line !== 'string') return;
        this.#processPacketLoggerLine(message.line);
        return;
      default:
        return;
    }
  }

  #processPacketLoggerLine(line) {
    const notification = parsePacketLoggerLine(line);
    if (!notification) return;
    for (const edge of this.#parser.feed(notification)) {
      try {
        this.#onEdge(edge);
      } catch {
        // listener errors must not kill the pump
      }
    }
  }
}
