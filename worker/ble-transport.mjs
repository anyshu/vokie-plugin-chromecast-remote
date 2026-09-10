// Host BLE adapter client for the Chromecast Voice Remote.
//
// Uses the versioned adapter messages (apiVersion "1"): ble_scan, ble_connect,
// ble_disconnect, ble_start_notify, ble_stop_notify, ble_write. The Host owns
// platform BLE permissions, the GATT lifecycle, and connection ownership; this
// module owns candidate selection, the ATVV capabilities handshake, and the
// device-level retry policy.
//
// Reconnect policy:
//   - Adapter/backend unavailable ("failed" naming the platform/helper) and
//     permission denials are permanent: the transport stops and reports error.
//   - Device-not-found and transient connect failures use capped backoff and
//     keep retrying while started, so the remote is picked up when it wakes.

import {
  ATVV_SERVICE_UUID,
  ATVV_COMMAND_UUID,
  ATVV_AUDIO_UUID,
  ATVV_CONTROL_UUID,
  GET_CAPABILITIES_COMMAND,
  parseControlEvent,
  selectCodec
} from './atvv-protocol.mjs';

// CoreBluetooth reports standard 16-bit characteristics in their short form
// (e.g. "2A4D"), while vendor UUIDs are full 128-bit strings. Subscribe with
// the short form first and fall back to the full Bluetooth base form.
export const HID_REPORT_UUID = '2A4D';
export const HID_REPORT_UUID_LONG = '00002a4d-0000-1000-8000-00805f9b34fb';

// Service UUIDs the remote may expose while already connected through the OS.
const CONNECTED_CACHE_HINT = [ATVV_SERVICE_UUID, '1812', '180F'];

const SCAN_WINDOW_MS = 8000;
const CAPABILITIES_TIMEOUT_MS = 3000;
const NOTIFY_WRITE_TIMEOUT_MS = 5000;
const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000];
const PERMANENT_MESSAGE_PATTERN = /adapter|backend|helper|platform|unavailable|not\s*supported|不支持|不可用/i;

const BLUETOOTH_BASE_SUFFIX = '00001000800000805f9b34fb';

/** trim + lowercase + remove hyphens, per the adapter's UUID comparison rule. */
export function canonicalUuid(uuid) {
  return String(uuid ?? '').trim().toLowerCase().replace(/-/g, '');
}

/**
 * UUID equality that treats a bare 4-hex short form as the Bluetooth base
 * UUID: "2A4D" === "00002A4D-0000-1000-8000-00805F9B34FB".
 */
export function uuidEquals(a, b) {
  const ca = canonicalUuid(a);
  const cb = canonicalUuid(b);
  const expand = (value) => (value.length === 4 ? `0000${value}${BLUETOOTH_BASE_SUFFIX}` : value);
  return expand(ca) === expand(cb);
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {object} options
 * @param {(message: object) => void} options.send  JSON sender to the Host socket
 * @param {(event: object) => void} options.onReady        device connected + ATVV negotiated
 * @param {(event: {characteristicUuid: string, data: Uint8Array}) => void} options.onNotification
 * @param {(reason: string) => void} options.onDeviceLost  link lost / handshake failed
 * @param {(info: object) => void} options.onStatus        progress info for the UI
 * @param {object} [options.clock] injectable {now(), setTimer(fn, ms), clearTimer(handle)}
 * @param {boolean} [options.subscribeHid] also subscribe the HID-over-GATT
 *        report characteristic (default true); false when the plugin reads
 *        buttons through its own IOKit helper instead.
 */
export class BleTransport {
  constructor({ send, onReady, onNotification, onDeviceLost, onStatus, clock, subscribeHid = true } = {}) {
    if (typeof send !== 'function') throw new Error('send is required');
    this.#send = send;
    this.#onReady = onReady ?? (() => {});
    this.#onNotification = onNotification ?? (() => {});
    this.#onDeviceLost = onDeviceLost ?? (() => {});
    this.#onStatus = onStatus ?? (() => {});
    // Public so the lifecycle layer can switch the GATT-HID preference when
    // the user changes hidSource at runtime.
    this.subscribeHid = subscribeHid !== false;
    this.#clock = clock ?? {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle)
    };

    this.started = false;
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null; // {version, codec, frameSize, sampleRate}
    this.hidSubscribed = false;

    this.#pending = new Map(); // requestId -> {kind, timer, resolve, reject, payload}
    this.#candidates = [];
    this.#failedDeviceIds = new Set();
    this.#timerHandles = new Set();
    this.#backoffIndex = 0;
    this.#generation = 0; // guards late async results from a stopped transport
  }

  #send;
  #onReady;
  #onNotification;
  #onDeviceLost;
  #onStatus;
  #clock;
  #pending;
  #candidates;
  #failedDeviceIds;
  #timerHandles;
  #backoffIndex;
  #generation;
  #capabilitiesTimer = null;
  #scanTimer = null;

  start() {
    if (this.started) return;
    this.started = true;
    this.#generation += 1;
    this.#beginScan('start');
  }

  stop() {
    if (!this.started && !this.deviceId && this.#pending.size === 0) return;
    this.started = false;
    this.#generation += 1;
    this.#clearTimers();
    for (const request of this.#pending.values()) {
      this.#clock.clearTimer(request.timer);
      request.reject(new Error('transport stopped'));
    }
    this.#pending.clear();
    this.#candidates = [];
    const hadDevice = this.deviceId;
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null;
    this.hidSubscribed = false;
    this.#backoffIndex = 0;
    if (hadDevice !== null) {
      // Best-effort release; the Host also releases on socket close.
      this.#send({ type: 'ble_disconnect', requestId: randomId('disconnect'), apiVersion: '1', deviceId: hadDevice });
    }
  }

  /** Fire-and-forget write to the ATVV command characteristic. */
  writeCommand(bytes) {
    if (!this.started || !this.deviceId) return Promise.resolve(false);
    return this.#request('ble_write', {
      deviceId: this.deviceId,
      characteristicUuid: ATVV_COMMAND_UUID,
      dataBase64: Buffer.from(bytes).toString('base64')
    }).then(() => true).catch(() => false);
  }

  /** Route a Host message; returns true when the message was a ble_* message. */
  handleHostMessage(message) {
    switch (message?.type) {
      case 'ble_scan_result':
        this.#handleScanResult(message);
        return true;
      case 'ble_accepted':
        this.#resolvePending(message.requestId, null);
        return true;
      case 'ble_rejected':
        this.#handleRejected(message);
        return true;
      case 'ble_notification':
        this.#handleNotification(message);
        return true;
      case 'ble_disconnected':
        this.#handleDisconnected(message);
        return true;
      default:
        return false;
    }
  }

  #request(kind, payload) {
    const requestId = randomId(kind);
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimer(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${kind} timed out`));
      }, NOTIFY_WRITE_TIMEOUT_MS);
      this.#pending.set(requestId, { kind, payload, timer, resolve, reject });
      this.#send({ type: kind, requestId, apiVersion: '1', ...payload });
    });
  }

  #resolvePending(requestId, error) {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    this.#clock.clearTimer(request.timer);
    if (error) request.reject(error);
    else request.resolve();
  }

  #handleRejected(message) {
    const request = this.#pending.get(message.requestId);
    const reason = message.reason ?? 'failed';
    const error = new Error(message.message ? `${reason}: ${message.message}` : reason);
    if (request) {
      this.#resolvePending(message.requestId, error);
      if (request.kind === 'ble_start_notify' && uuidEquals(request.payload.characteristicUuid, HID_REPORT_UUID)) {
        // HID-over-GATT may be unavailable (unbonded remote enforcing HID
        // encryption, or a spelling the backend did not discover). Contained:
        // voice still works; undo/send degrade. #setupDevice retries the
        // alternate UUID spelling before giving up.
        this.hidSubscribed = false;
        this.#onStatus({ hidAvailable: false, hidError: message.message ?? reason });
        return;
      }
      if (request.kind === 'ble_start_notify' && uuidEquals(request.payload.characteristicUuid, ATVV_COMMAND_UUID)) {
        // Some remotes do not notify on the command characteristic; optional.
        return;
      }
    }
    if (!this.started) return;
    if (reason === 'permission_denied' || reason === 'invalid_request') {
      this.#failPermanently(`蓝牙适配器拒绝请求（${reason}）${message.message ? `：${message.message}` : ''}`);
      return;
    }
    if (reason === 'failed' && PERMANENT_MESSAGE_PATTERN.test(message.message ?? '')) {
      this.#failPermanently(message.message ?? '蓝牙适配器不可用');
      return;
    }
    if (request?.kind === 'ble_connect') {
      // A rejected connect can follow a brief native link; clean up before retry.
      this.#send({
        type: 'ble_disconnect',
        requestId: randomId('disconnect-cleanup'),
        apiVersion: '1',
        deviceId: request.payload.deviceId
      });
      this.#failedDeviceIds.add(request.payload.deviceId);
      this.deviceId = null;
      this.#retryLater(`连接失败（${reason}）`);
      return;
    }
    if (request?.kind === 'ble_scan') {
      this.#retryLater(`扫描失败（${reason}）`);
    }
  }

  #beginScan(cause) {
    if (!this.started) return;
    this.#onStatus({ phase: 'scanning', cause });
    this.#candidates = [];
    const generation = this.#generation;
    this.#scanTimer = this.#trackTimer(() => {
      if (this.#generation !== generation || !this.started) return;
      if (!this.deviceId && !this.#candidates.length) this.#retryLater('扫描超时，未发现遥控器');
    }, SCAN_WINDOW_MS);
    this.#request('ble_scan', {
      filter: { serviceUuid: ATVV_SERVICE_UUID, connectedServiceUuids: CONNECTED_CACHE_HINT }
    }).catch(() => { /* rejection handled in #handleRejected */ });
  }

  #handleScanResult(message) {
    if (!this.started || this.deviceId) return;
    const devices = Array.isArray(message.devices) ? message.devices : [];
    for (const device of devices) {
      if (!device?.deviceId || this.#failedDeviceIds.has(device.deviceId)) continue;
      this.#candidates.push(device);
    }
    const candidate = this.#pickCandidate();
    if (!candidate) return;
    if (this.#scanTimer) {
      this.#clock.clearTimer(this.#scanTimer);
      this.#scanTimer = null;
    }
    this.#connect(candidate);
  }

  #pickCandidate() {
    if (!this.#candidates.length) return null;
    this.#candidates.sort((a, b) => Number(/\bchromecast\b/i.test(b.name ?? '')) - Number(/\bchromecast\b/i.test(a.name ?? '')));
    return this.#candidates.shift();
  }

  #connect(candidate) {
    if (!this.started || this.deviceId) return;
    const generation = this.#generation;
    this.#onStatus({ phase: 'connecting', deviceName: candidate.name ?? null });
    this.#request('ble_connect', { deviceId: candidate.deviceId })
      .then(() => {
        if (this.#generation !== generation || !this.started) {
          this.#send({ type: 'ble_disconnect', requestId: randomId('disconnect-stale'), apiVersion: '1', deviceId: candidate.deviceId });
          return;
        }
        this.deviceId = candidate.deviceId;
        this.deviceName = candidate.name ?? null;
        this.#failedDeviceIds.delete(candidate.deviceId);
        void this.#setupDevice();
      })
      .catch(() => { /* handled in #handleRejected */ });
  }

  async #setupDevice() {
    const deviceId = this.deviceId;
    const generation = this.#generation;
    // Subscribe before writing the capabilities query so the response cannot
    // race the subscription. Order: control, audio, HID report, command echo.
    // Each optional channel may carry alternate UUID spellings (CoreBluetooth
    // reports standard 16-bit characteristics in short form).
    const subscriptions = [
      { spellings: [ATVV_CONTROL_UUID], required: true },
      { spellings: [ATVV_AUDIO_UUID], required: true },
      { spellings: [HID_REPORT_UUID, HID_REPORT_UUID_LONG], required: false, skip: !this.subscribeHid },
      { spellings: [ATVV_COMMAND_UUID], required: false }
    ];
    for (const { spellings, required, skip } of subscriptions) {
      if (skip) continue;
      let subscribed = null;
      for (const characteristicUuid of spellings) {
        try {
          await this.#request('ble_start_notify', { deviceId, characteristicUuid });
          if (this.#generation !== generation || !this.started) return;
          subscribed = characteristicUuid;
          break;
        } catch (error) {
          if (this.#generation !== generation || !this.started) return;
          // Try the next spelling for this channel.
        }
      }
      if (subscribed === null) {
        if (!required) continue; // optional channel (HID report / command echo)
        this.deviceId = null;
        this.#send({ type: 'ble_disconnect', requestId: randomId('disconnect-notify'), apiVersion: '1', deviceId });
        this.#failedDeviceIds.add(deviceId);
        this.#retryLater('订阅特征失败');
        return;
      }
      if (uuidEquals(subscribed, HID_REPORT_UUID)) this.hidSubscribed = true;
    }
    this.#onStatus({ phase: 'negotiating', deviceName: this.deviceName });
    this.#capabilitiesTimer = this.#trackTimer(() => {
      if (this.#generation !== generation || !this.started) return;
      this.#dropDevice('capabilities_timeout');
    }, CAPABILITIES_TIMEOUT_MS);
    const written = await this.writeCommand(GET_CAPABILITIES_COMMAND);
    if (!written && this.started && this.#generation === generation) {
      this.#dropDevice('command_write_failed');
    }
  }

  #handleNotification(message) {
    if (!this.started || !this.deviceId || message.deviceId !== this.deviceId) return;
    let bytes;
    try {
      bytes = new Uint8Array(Buffer.from(message.dataBase64 ?? '', 'base64'));
    } catch {
      return;
    }
    if (uuidEquals(message.characteristicUuid, ATVV_CONTROL_UUID) || uuidEquals(message.characteristicUuid, ATVV_COMMAND_UUID)) {
      this.#handleControlBytes(bytes, message.characteristicUuid);
      return;
    }
    this.#onNotification({ characteristicUuid: message.characteristicUuid, data: bytes });
  }

  #handleControlBytes(bytes, characteristicUuid) {
    const event = parseControlEvent(bytes, this.atvv);
    if (event?.type === 'capabilities') {
      this.#acceptCapabilities(event.capabilities);
      return;
    }
    if (event?.type === 'audio_sync' && !this.atvv) return; // sync before caps: ignore
    if (this.atvv) {
      this.#onNotification({
        characteristicUuid: uuidEquals(characteristicUuid, ATVV_CONTROL_UUID) ? ATVV_CONTROL_UUID : ATVV_COMMAND_UUID,
        data: bytes
      });
    }
  }

  #acceptCapabilities(capabilities) {
    if (!this.started || !this.deviceId) return;
    const codec = selectCodec(capabilities);
    if (!codec) {
      this.#dropDevice('unsupported_codec');
      return;
    }
    if (this.#capabilitiesTimer) {
      this.#clock.clearTimer(this.#capabilitiesTimer);
      this.#capabilitiesTimer = null;
    }
    this.atvv = {
      ...capabilities,
      codec,
      sampleRate: codec === 0x02 ? 16000 : 8000
    };
    this.#backoffIndex = 0;
    this.#onReady({
      deviceId: this.deviceId,
      name: this.deviceName,
      atvv: this.atvv,
      hidSubscribed: this.hidSubscribed
    });
  }

  #handleDisconnected(message) {
    if (!this.started || !this.deviceId || message.deviceId !== this.deviceId) return;
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null;
    this.hidSubscribed = false;
    this.#candidates = [];
    this.#onDeviceLost(message.reason ?? 'link_lost');
    if (this.started) this.#retryLater(`设备断开（${message.reason ?? 'link_lost'}）`);
  }

  #dropDevice(reason) {
    const deviceId = this.deviceId;
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null;
    this.hidSubscribed = false;
    if (deviceId !== null) {
      this.#send({ type: 'ble_disconnect', requestId: randomId('disconnect-drop'), apiVersion: '1', deviceId });
      this.#onDeviceLost(reason);
    }
    if (this.started) this.#retryLater(`连接重置（${reason}）`);
  }

  #retryLater(cause) {
    if (!this.started) return;
    const delay = BACKOFF_SEQUENCE_MS[Math.min(this.#backoffIndex, BACKOFF_SEQUENCE_MS.length - 1)];
    this.#backoffIndex += 1;
    this.#onStatus({ phase: 'backoff', cause, retryInMs: delay });
    const generation = this.#generation;
    this.#trackTimer(() => {
      if (this.#generation === generation && this.started && !this.deviceId) this.#beginScan(cause);
    }, delay);
  }

  #failPermanently(message) {
    this.started = false;
    this.#clearTimers();
    for (const request of this.#pending.values()) {
      this.#clock.clearTimer(request.timer);
      request.reject(new Error('transport stopped'));
    }
    this.#pending.clear();
    this.deviceId = null;
    this.atvv = null;
    this.#onStatus({ phase: 'error', message });
  }

  #trackTimer(fn, ms) {
    const handle = this.#clock.setTimer(fn, ms);
    this.#timerHandles.add(handle);
    return handle;
  }

  #clearTimers() {
    for (const handle of this.#timerHandles) this.#clock.clearTimer(handle);
    this.#timerHandles.clear();
    this.#scanTimer = null;
    this.#capabilitiesTimer = null;
  }
}
