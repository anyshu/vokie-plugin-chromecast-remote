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

import { pickChromecastCandidate } from './ble-device-selection.mjs';

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
// An unsupported characteristic is a device-operation failure, not evidence
// that the entire adapter is unavailable. Require an explicit backend failure.
const BACKEND_UNAVAILABLE_PATTERN = /\b(?:adapter|backend|helper|platform)\s+(?:is\s+)?(?:unavailable|missing|disabled|not\s+(?:available|supported|installed|found))\b|(?:适配器|后端|助手|平台)(?:当前|暂时)?(?:不可用|不支持|未安装|未启用|缺失)/i;

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
    this.#failedDeviceIds = new Map();
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
  #failedDeviceIds;
  #timerHandles;
  #backoffIndex;
  #generation;
  #capabilitiesTimer = null;
  #scanRequestId = null;
  #retryTimer = null;
  #releasing = null;
  #unreleasedDeviceId = null;

  #preferredDeviceId = null;

  setPreferredDeviceId(deviceId) {
    const next = typeof deviceId === 'string' && deviceId.trim() ? deviceId : null;
    if (this.#preferredDeviceId === next) return;
    this.#preferredDeviceId = next;
    if (this.started && this.deviceId && next && this.deviceId.toLowerCase() !== next.toLowerCase()) {
      this.#dropDevice('HID 身份已更新，切换到对应遥控器');
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.#generation += 1;
    this.#failedDeviceIds.clear();
    const generation = this.#generation;
    if (this.#releasing || this.#unreleasedDeviceId) {
      void this.#releaseDevice(this.#unreleasedDeviceId).then((released) => {
        if (released && this.started && this.#generation === generation) this.#beginScan('start');
      });
    } else {
      this.#beginScan('start');
    }
  }

  stop() {
    if (!this.started && !this.deviceId && this.#pending.size === 0) return;
    this.started = false;
    this.#generation += 1;
    this.#clearTimers();
    this.#cancelOperations();
    const hadDevice = this.deviceId;
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null;
    this.hidSubscribed = false;
    this.#backoffIndex = 0;
    if (hadDevice !== null) {
      void this.#releaseDevice(hadDevice);
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
        // A scan ack is not the result; keep its request alive until scan_result.
        if (this.#pending.get(message.requestId)?.kind !== 'ble_scan') this.#resolvePending(message.requestId, null);
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
    if (kind === 'ble_scan') this.#scanRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimer(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${kind} timed out`));
      }, kind === 'ble_scan' ? SCAN_WINDOW_MS + 2000 : NOTIFY_WRITE_TIMEOUT_MS);
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
    if (!request) return; // old generation / unrelated plugin response
    const reason = message.reason ?? 'failed';
    const error = new Error(message.message ? `${reason}: ${message.message}` : reason);
    this.#onStatus({ requestFailure: {
      operation: request.kind,
      characteristicUuid: request.payload.characteristicUuid ?? null,
      reason, message: message.message ?? reason
    } });
    this.#resolvePending(message.requestId, error);
    if (!this.started || request.kind === 'ble_disconnect') return;
    if (reason === 'permission_denied' || reason === 'invalid_request' ||
        (reason === 'failed' && BACKEND_UNAVAILABLE_PATTERN.test(message.message ?? ''))) {
      const target = request.payload.characteristicUuid ? ` ${request.payload.characteristicUuid}` : '';
      this.#failPermanently(`蓝牙适配器拒绝请求（${request.kind}${target}）：${error.message}`);
    }
    // Per-operation catches own recovery, including connect timeouts.
  }

  #beginScan(cause) {
    if (!this.started || this.deviceId || this.#releasing || this.#scanRequestId) return;
    this.#onStatus({ phase: 'scanning', cause });
    const generation = this.#generation;
    this.#request('ble_scan', {
      filter: { serviceUuid: ATVV_SERVICE_UUID, namePrefix: 'Chromecast', connectedServiceUuids: CONNECTED_CACHE_HINT }
    }).catch((error) => {
      if (this.#generation !== generation || !this.started) return;
      this.#scanRequestId = null;
      this.#retryLater(`扫描失败：${error.message}`);
    });
  }

  #handleScanResult(message) {
    if (!this.started || this.deviceId || message.requestId !== this.#scanRequestId ||
        this.#pending.get(message.requestId)?.kind !== 'ble_scan') return;
    this.#resolvePending(message.requestId, null);
    this.#scanRequestId = null;
    const devices = Array.isArray(message.devices) ? message.devices : [];
    const now = this.#clock.now();
    for (const [id, until] of this.#failedDeviceIds) if (until <= now) this.#failedDeviceIds.delete(id);
    const candidate = pickChromecastCandidate(this.#preferredDeviceId ? devices.filter(device =>
      typeof device?.deviceId === 'string' && device.deviceId.toLowerCase() === this.#preferredDeviceId.toLowerCase()) : devices, this.#failedDeviceIds, now);
    this.#onStatus({
      phase: 'scanning', candidateCount: devices.length,
      selectedDeviceId: candidate?.deviceId ?? null,
      selectedDeviceName: candidate?.name ?? null,
      cause: candidate ? '已识别 Chromecast 候选设备' : '未发现可连接的 Chromecast；忽略其他型号和无名称设备'
    });
    if (!candidate) { this.#retryLater('等待 Chromecast 遥控器'); return; }
    this.#connect(candidate);
  }

  #connect(candidate) {
    if (!this.started || this.deviceId) return;
    const generation = this.#generation;
    // Reserve while connecting, so repeated scan results cannot open two links.
    this.deviceId = candidate.deviceId;
    this.deviceName = candidate.name;
    this.#onStatus({ phase: 'connecting', deviceId: this.deviceId, deviceName: this.deviceName });
    this.#request('ble_connect', { deviceId: candidate.deviceId })
      .then(() => {
        if (this.#generation !== generation || !this.started) return;
        void this.#setupDevice(); // required ATVV characteristics validate the link
      })
      .catch((error) => {
        if (this.#generation !== generation || !this.started) return;
        this.#failedDeviceIds.set(candidate.deviceId, this.#clock.now() + 10000);
        this.#dropDevice(`连接失败：${error.message}`);
      });
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
      let lastFailure = null;
      for (const characteristicUuid of spellings) {
        try {
          await this.#request('ble_start_notify', { deviceId, characteristicUuid });
          if (this.#generation !== generation || !this.started) return;
          subscribed = characteristicUuid;
          break;
        } catch (error) {
          if (this.#generation !== generation || !this.started) return;
          lastFailure = `${characteristicUuid}: ${error.message}`;
          // Try the next spelling for this channel.
        }
      }
      if (subscribed === null) {
        if (!required) {
          if (uuidEquals(spellings[0], HID_REPORT_UUID)) {
            this.#onStatus({ hidAvailable: false, hidError: 'GATT 按键不可达；macOS 配对状态下请使用原生助手' });
          }
          continue;
        }
        this.#failedDeviceIds.set(deviceId, this.#clock.now() + 10000);
        this.#dropDevice(`必需的 ATVV 通知订阅失败（${lastFailure}）`);
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
      this.#handleControlBytes(bytes, message.characteristicUuid,
        Number.isFinite(message.receivedAtMs) ? message.receivedAtMs : this.#clock.now());
      return;
    }
    if (!this.atvv) return;
    if (!uuidEquals(message.characteristicUuid, ATVV_AUDIO_UUID) &&
        !(this.hidSubscribed && uuidEquals(message.characteristicUuid, HID_REPORT_UUID))) return;
    this.#onNotification({ characteristicUuid: message.characteristicUuid, data: bytes,
      receivedAtMs: Number.isFinite(message.receivedAtMs) ? message.receivedAtMs : this.#clock.now() });
  }

  #handleControlBytes(bytes, characteristicUuid, receivedAtMs) {
    const event = parseControlEvent(bytes, this.atvv);
    if (event?.type === 'capabilities') {
      this.#acceptCapabilities(event.capabilities);
      return;
    }
    if (event?.type === 'audio_sync' && !this.atvv) return; // sync before caps: ignore
    if (this.atvv) {
      this.#onNotification({
        characteristicUuid: uuidEquals(characteristicUuid, ATVV_CONTROL_UUID) ? ATVV_CONTROL_UUID : ATVV_COMMAND_UUID,
        data: bytes, receivedAtMs
      });
    }
  }

  #acceptCapabilities(capabilities) {
    if (!this.started || !this.deviceId || this.atvv || !this.#capabilitiesTimer) return;
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
    // Explicit disconnect may emit this before its ack. Wait for the ack to
    // establish that the backend's pending native operation is fully cleared.
    if (this.#releasing?.deviceId === message.deviceId) return;
    if (!this.started || !this.deviceId || message.deviceId !== this.deviceId) return;
    this.#resetConnection(message.reason ?? 'link_lost');
    this.#retryLater(`设备断开（${message.reason ?? 'link_lost'}）`);
  }

  #resetConnection(reason) {
    const hadDevice = this.deviceId !== null;
    this.#generation += 1;
    this.#clearTimers();
    this.#cancelOperations();
    this.deviceId = null;
    this.deviceName = null;
    this.atvv = null;
    this.hidSubscribed = false;
    if (hadDevice) this.#onDeviceLost(reason);
  }

  #dropDevice(reason) {
    const deviceId = this.deviceId;
    this.#resetConnection(reason);
    const generation = this.#generation;
    void this.#releaseDevice(deviceId).then((released) => {
      if (released && this.started && this.#generation === generation) this.#retryLater(`连接重置（${reason}）`);
    });
  }

  #releaseDevice(deviceId) {
    if (this.#releasing) return this.#releasing.promise;
    if (deviceId === null) return Promise.resolve(true);
    this.#unreleasedDeviceId = deviceId;
    const release = { deviceId, promise: null };
    this.#releasing = release;
    release.promise = this.#request('ble_disconnect', { deviceId }).then(() => {
      this.#unreleasedDeviceId = null;
      return true;
    }).catch((error) => {
      // Do not reconnect while ownership/native cleanup is uncertain.
      if (this.started) {
        this.started = false;
        this.#onStatus({ phase: 'error', message: `蓝牙连接释放失败，请重启插件：${error.message}` });
      }
      return false;
    }).finally(() => { if (this.#releasing === release) this.#releasing = null; });
    return release.promise;
  }

  #retryLater(cause) {
    if (!this.started || this.#retryTimer || this.#releasing) return;
    const delay = BACKOFF_SEQUENCE_MS[Math.min(this.#backoffIndex, BACKOFF_SEQUENCE_MS.length - 1)];
    this.#backoffIndex += 1;
    this.#onStatus({ phase: 'backoff', cause, retryInMs: delay });
    const generation = this.#generation;
    this.#retryTimer = this.#trackTimer(() => {
      this.#retryTimer = null;
      if (this.#generation === generation && this.started && !this.deviceId) this.#beginScan(cause);
    }, delay);
  }

  #failPermanently(message) {
    const deviceId = this.deviceId;
    this.started = false;
    this.#resetConnection(message);
    if (deviceId !== null) void this.#releaseDevice(deviceId);
    this.#onStatus({ phase: 'error', message });
  }

  #cancelOperations() {
    this.#scanRequestId = null;
    for (const [id, request] of this.#pending) {
      if (request.kind === 'ble_disconnect') continue;
      this.#clock.clearTimer(request.timer);
      this.#pending.delete(id);
      request.reject(new Error('transport stopped'));
    }
  }

  #trackTimer(fn, ms) {
    const handle = this.#clock.setTimer(() => {
      this.#timerHandles.delete(handle);
      fn();
    }, ms);
    this.#timerHandles.add(handle);
    return handle;
  }

  #clearTimers() {
    for (const handle of this.#timerHandles) this.#clock.clearTimer(handle);
    this.#timerHandles.clear();
    this.#capabilitiesTimer = null;
    this.#retryTimer = null;
  }
}
