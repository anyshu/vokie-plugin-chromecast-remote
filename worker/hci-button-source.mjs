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
// protocol `vokie.appleTvRemote.hci` v4) runs PacketLogger and forwards the
// nhdr stream; buttons appear there as raw ATT notifications. This mirrors
// the app-side GoogleTvRemoteHelper (same socket, same protocol, same byte
// semantics, field-tested 2026-09-11..13).
//
//   request  : {"id","protocol":"vokie.appleTvRemote.hci","command":
//              "startCapture"|"stopCapture"|"seizeHid"|"releaseHid",
//              "requiredVersion":"4",
//              "caller":{"pid","uid"},"captureId","remoteDeviceId":null}
//   response : {"type":"captureStarted"|"captureStopped"|
//              "captureUnavailable"|"error", ...}
//              {"type":"nhdr","captureId","line":"<PacketLogger nhdr line>"}
//
// Legacy: handle 0x002B, two-byte select/back/release reports.
// A0 / 26.2: handle 0x0029, eight-byte reports; serial-verified HCI identity
// is required even when PacketLogger shows the expected name/address.
// Profile and identity rules are ported from xiguashuo-pc 40ba1c2f.
//
// v4 shares one PacketLogger capture among multiple clients. It can also seize
// this remote's HID collections in the privileged process so the OK key does
// not reach media players. Seize failure is a degraded state: HCI button
// capture remains usable. Definitive capture failures (socket missing, version
// mismatch, PacketLogger missing, …) are reported with `definitive: true` so
// `auto` mode can fall back to the IOKit helper.
//
// The first subscriber starts the shared capture and the last subscriber
// stops it; only those two global boundaries reload bluetoothd. The daemon
// also removes a client's subscription when the connection drops.

import { createConnection } from 'node:net';
import { buttonReport, remoteProfile, matchesHciSource } from './remote-profile.mjs';
import { HciIdentity, parseTraceLine, attPacket } from './hci-identity.mjs';

export const HCI_PROTOCOL = 'vokie.appleTvRemote.hci';
export const HCI_REQUIRED_VERSION = '4';
export const DEFAULT_HCI_SOCKET_PATH = '/var/run/com.vokie.hci.sock';

export const REMOTE_DEVICE_NAME = 'Chromecast Remote';
export const BUTTON_GATT_HANDLE = 0x002b;

const L2CAP_ATT_CID = 0x0004;
const ATT_HANDLE_VALUE_NOTIFICATION = 0x1b;

const CONNECT_TIMEOUT_MS = 800;
const RETRY_MS = 5000;
const GOOGLE_VENDOR_ID = 0x18d1;
const CHROMECAST_REMOTE_PRODUCT_ID = 0x9450;

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
  const trace = parseTraceLine(line);
  if (!trace?.received || trace.source.toLowerCase() !== deviceName.toLowerCase()) return null;
  return parseAclBytes(trace.bytes);
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
  if (!attPacket(bytes) || bytes.length < 11) return null;
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
  profile = 'legacy';
  #selectPressed = false;
  #backPressed = false;

  /** @returns {Array<{button: 'select'|'back', isDown: boolean}>} */
  feed({ gattHandle, value }) {
    const report = buttonReport(this.profile, { gattHandle, value });
    if (!report) return [];

    if (report === 'select') {
      if (this.#selectPressed) return [];
      this.#selectPressed = true;
      return [{ button: 'select', isDown: true }];
    }
    if (report === 'back') {
      if (this.#backPressed) return [];
      this.#backPressed = true;
      return [{ button: 'back', isDown: true }];
    }
    if (report === 'released') {
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
    return [];
  }

  reset() {
    this.#selectPressed = false;
    this.#backPressed = false;
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
  constructor({ socketPath, onEdge, onStatus, onIdentity, suppressNative, clock } = {}) {
    this.#onIdentity = onIdentity;
    this.#socketPath = socketPath ?? DEFAULT_HCI_SOCKET_PATH;
    this.#onEdge = onEdge ?? (() => {});
    this.#onStatus = onStatus ?? (() => {});
    this.#clock = clock ?? {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle)
    };
    this.#suppressNative = suppressNative !== false;
    this.#parser = new HciButtonValueParser();
  }

  #identity = new HciIdentity();
  #device = null;
  #onIdentity;
  #suppressNative;
  #hidSeized = false;
  #hidSeizeError = null;

  get buttonsReady() { return this.active && (this.#parser.profile !== 'a0' || this.#identity.connectionHandle !== null); }

  get hidSeized() { return this.#hidSeized; }

  setSuppressNative(enabled) {
    const next = enabled !== false;
    if (next === this.#suppressNative) return;
    this.#suppressNative = next;
    this.#hidSeizeError = null;
    if (!this.#captureActive) return;
    if (next) {
      this.#requestHidSeize();
    } else {
      this.#sendRequest('releaseHid');
      this.#hidSeized = false;
      this.#status({ phase: 'capturing', hidSeized: false, hidSeizeError: null });
    }
  }

  setDevice(device) {
    this.#device = device;
    this.#parser.profile = remoteProfile(device?.modelNumber);
    this.#parser.reset();
    this.#resetIdentity();
  }

  identityMessage(message) {
    if (!this.active || this.#parser.profile !== 'a0' || message.deviceId !== this.#device?.deviceId) return;
    if (message.type === 'identity_probe') {
      if (message.serialNumber !== this.#device?.serialNumber) return;
      this.#identity.begin(message.serialNumber, Date.now());
    } else if (message.type === 'identity_confirm') {
      this.#identity.confirm(Buffer.from(message.data ?? '', 'base64'), Date.now());
    } else if (message.type === 'identity_reset') {
      this.#resetIdentity();
    }
    this.#notifyIdentity();
  }

  #resetIdentity() {
    this.#identity.reset();
    this.#notifyIdentity();
  }

  #notifyIdentity() {
    this.#onIdentity?.({ verified: this.#identity.connectionHandle !== null,
      required: this.#parser.profile === 'a0', connectionHandle: this.#identity.connectionHandle });
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
  #pendingCommands = new Map();
  #retryTimer = null;
  #connectTimer = null;
  #lastError = null;
  #captureId = `chromecast-plugin-${process.pid}`;

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
    const socket = this.#socket;
    if (socket && !socket.destroyed) {
      if (this.#hidSeized || this.#suppressNative) this.#sendRequest('releaseHid');
      if (this.#captureActive) this.#sendRequest('stopCapture');
      this.#captureActive = false;
      this.#hidSeized = false;
      this.#hidSeizeError = null;
      this.#parser.reset();
      this.#resetIdentity();
      socket.end();
    } else {
      this.#closeSocket();
    }
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
    this.#hidSeized = false;
    this.#hidSeizeError = null;
    this.#lineBuffer = '';
    this.#pendingCommands.clear();
    this.#parser.reset();
    this.#resetIdentity();
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

  #sendRequest(command, extra = {}) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return;
    this.#requestCounter += 1;
    const id = `chromecast-plugin-${process.pid}-${this.#requestCounter}`;
    const request = {
      id,
      protocol: HCI_PROTOCOL,
      command,
      requiredVersion: HCI_REQUIRED_VERSION,
      caller: {
        pid: process.pid,
        uid: typeof process.getuid === 'function' ? process.getuid() : null
      },
      captureId: this.#captureId,
      remoteDeviceId: null,
      ...extra
    };
    this.#pendingCommands.set(id, command);
    socket.write(JSON.stringify(request) + '\n');
  }

  #requestHidSeize() {
    if (!this.#captureActive || !this.#suppressNative) return;
    this.#hidSeized = false;
    this.#hidSeizeError = null;
    this.#sendRequest('seizeHid', {
      vendorId: GOOGLE_VENDOR_ID,
      productId: CHROMECAST_REMOTE_PRODUCT_ID
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const command = typeof message?.id === 'string' ? this.#pendingCommands.get(message.id) : null;
    if (typeof message?.id === 'string') this.#pendingCommands.delete(message.id);
    if (
      typeof message?.captureId === 'string' &&
      message.captureId !== this.#captureId &&
      ['captureStarted', 'captureStopped', 'nhdr'].includes(message.type)
    ) return;
    switch (message?.type) {
      case 'captureStarted':
        if (this.#retryTimer) {
          this.#clock.clearTimer(this.#retryTimer);
          this.#retryTimer = null;
        }
        if (this.#captureActive) return;
        this.#captureActive = true;
        this.#hidSeized = false;
        this.#hidSeizeError = null;
        this.#parser.reset();
        this.#resetIdentity();
        this.#status({ phase: 'capturing', error: null, hidSeized: false, hidSeizeError: null });
        this.#requestHidSeize();
        console.error(`[cast-hci] capture started (${this.#socketPath})`);
        return;
      case 'captureStopped':
        // Unexpected mid-stream stop: the daemon ends the capture but keeps
        // the socket open, so ask for it again.
        this.#captureActive = false;
        this.#hidSeized = false;
        this.#parser.reset();
        this.#resetIdentity();
        this.#scheduleRetry('HCI 抓包被停止，重新请求');
        this.#sendRequest('startCapture');
        return;
      case 'captureUnavailable':
      case 'error': {
        const error = String(message.message ?? (message.type === 'error' ? 'HCI 守护进程错误' : 'HCI 抓包不可用'));
        if (command === 'seizeHid' || command === 'releaseHid') {
          this.#hidSeized = false;
          this.#hidSeizeError = error;
          this.#status({ phase: 'capturing', hidSeized: false, hidSeizeError: error });
          console.error(`[cast-hci] HID suppression unavailable: ${error}`);
          return;
        }
        this.#captureActive = false;
        console.error(`[cast-hci] ${message.type}: ${error}`);
        this.#scheduleRetry(error);
        return;
      }
      case 'versionMismatch': {
        const actual = typeof message.version === 'string' ? message.version : '未知';
        const error = `HCI 组件版本不兼容（需要 v${HCI_REQUIRED_VERSION}，当前 v${actual}）`;
        this.#captureActive = false;
        this.#scheduleRetry(error);
        return;
      }
      case 'hidSeized':
        this.#hidSeized = true;
        this.#hidSeizeError = null;
        this.#status({
          phase: 'capturing',
          hidSeized: true,
          hidSeizeError: null,
          hidSeizedCount: Number(message.seized ?? 0),
          hidSeizeFailedCount: Number(message.failed ?? 0)
        });
        return;
      case 'hidSeizeFailed': {
        const error = String(message.message ?? 'HID 抢占失败');
        this.#hidSeized = false;
        this.#hidSeizeError = error;
        this.#status({ phase: 'capturing', hidSeized: false, hidSeizeError: error });
        return;
      }
      case 'hidReleased':
        this.#hidSeized = false;
        this.#hidSeizeError = null;
        this.#status({ phase: 'capturing', hidSeized: false, hidSeizeError: null });
        return;
      case 'nhdr':
        if (!this.#captureActive || typeof message.line !== 'string') return;
        this.#processPacketLoggerLine(message.line);
        return;
      default:
        return;
    }
  }

  #processPacketLoggerLine(line) {
    const trace = parseTraceLine(line);
    if (!trace) return;
    const known = matchesHciSource(trace.source, this.#device?.deviceAddress);
    if (this.#parser.profile === 'a0') {
      if (!known && trace.source !== '00:00:00:00:00:00') return;
      const previous = this.#identity.connectionHandle;
      this.#identity.observe(trace.bytes, trace.received, Date.now());
      if (previous !== this.#identity.connectionHandle) {
        this.#parser.reset();
        this.#notifyIdentity();
      }
      if (!trace.received || !this.#identity.accepts(trace.bytes)) return;
    } else if (!trace.received || !known) return;
    const notification = parseAclBytes(trace.bytes);
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
