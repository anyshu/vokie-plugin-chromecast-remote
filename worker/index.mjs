#!/usr/bin/env node
// Vokie plugin worker: Chromecast Voice Remote over BLE.
//
// Connects to the Vokie Host through the authenticated plugin WebSocket
// (VOKIE_PLUGIN_WS_URL / VOKIE_PLUGIN_TOKEN), then bridges the remote's ATVV
// voice stream and HID buttons to Vokie sessions and commands:
//
//   voice key long press  -> handsfree-ptt session (hold-to-talk)
//   voice key short press -> ptt session (tap to toggle)
//   back button           -> undo_last_output command
//   select (OK) button    -> send_enter command
//
// The BLE link itself goes through the Host's versioned GATT adapter
// (ble_scan/ble_connect/ble_start_notify/ble_write, apiVersion "1"); the
// worker owns the ATVV vendor protocol, gesture semantics, ADPCM decoding,
// and 16 kHz PCM framing.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BleTransport, HID_REPORT_UUID, uuidEquals } from './ble-transport.mjs';
import {
  ATVV_AUDIO_UUID,
  ATVV_COMMAND_UUID,
  ATVV_CONTROL_UUID,
  parseControlEvent
} from './atvv-protocol.mjs';
import { HidButtonParser } from './hid-reports.mjs';
import { DeviceSession, DEFAULT_CONFIG } from './device-session.mjs';
import { HostSession } from './host-session.mjs';
import { HidHelperSource } from './hid-helper-source.mjs';

// Echo of vokie.plugin.json. The Host deep-compares id/name/version/apiVersion/
// platforms/transports/capabilities/permissions (plus normalized icon and
// ui.entrypoint) during the plugin_hello handshake and rejects any mismatch
// with close code 1008, so these fields must stay identical to the manifest.
const manifest = {
  id: 'eb5f9200-de02-49bf-b602-57c49ebf78b9',
  name: 'Chromecast Voice Remote',
  device: { type: 'Chromecast Voice Remote', model: 'Google 18D1:9450' },
  version: '0.2.6',
  apiVersion: '1',
  platforms: ['darwin'],
  transports: ['ble', 'hid'],
  capabilities: {
    ptt: true,
    handsfree: true,
    longRecording: false,
    translation: false,
    liveTranslation: false,
    sendEnter: true,
    undoLastOutput: true
  },
  permissions: ['bluetooth', 'native-helper'],
  icon: 'assets/icon.svg',
  ui: { entrypoint: 'ui/index.html' },
  worker: { entrypoint: 'worker/index.mjs', args: [] }
};

const wsUrl = process.env.VOKIE_PLUGIN_WS_URL;
const token = process.env.VOKIE_PLUGIN_TOKEN;
if (!wsUrl || !token) {
  throw new Error('VOKIE_PLUGIN_WS_URL and VOKIE_PLUGIN_TOKEN are required');
}

// IOKit HID helper: bundled, self-contained macOS binary. The env override is
// for tests and diagnostics.
const helperPath =
  process.env.VOKIE_HID_HELPER || fileURLToPath(new URL('../assets/chromecast-hid-helper', import.meta.url));

console.error(`[cast-plugin] id=${manifest.id} version=${manifest.version} worker=${fileURLToPath(import.meta.url)} helper=${helperPath}`);

let socket;
let started = false;
let config = { ...DEFAULT_CONFIG, hidSource: 'auto', hidSuppressNative: true };
const hidParser = new HidButtonParser();

function send(message) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
}

function sendBinary(buffer) {
  if (socket?.readyState === 1) socket.send(buffer);
}

// ---------------------------------------------------------------------------
// Plugin state. Core values are the Host-owned set; everything else lives in
// the opaque extensions object, replaced wholesale on every emission.

const extensionState = {
  package: { id: manifest.id, version: manifest.version },
  device: { connected: false, name: null, atvvVersion: null, codec: null, sampleRate: null, hidAvailable: false, hidSource: null, hidError: null },
  bluetooth: { phase: 'idle', cause: null, retryInMs: null },
  session: { mode: null, phase: 'idle', accepted: false, lastEndCause: null, lastEndAt: null },
  settings: {
    voiceMode: DEFAULT_CONFIG.voiceMode,
    hidSource: 'auto',
    hidSuppressNative: true
  }
};

function emitState(core) {
  // Always emit: the Host replaces the whole extensions object on every
  // state event, and two consecutive events with the same core value can
  // still carry different extension payloads (e.g. reconnect causes).

  send({ type: 'state', state: core, extensions: structuredClone(extensionState) });
}

function updateExtensions(section, patch) {
  Object.assign(extensionState[section], patch);
}

// ---------------------------------------------------------------------------
// Vokie session bridge and device session.

const hostSession = new HostSession({ sendJson: send, sendBinary });
let sessionStartFrames = 0;

function noteEndCause(cause) {
  const frames = hostSession.totalFrames - sessionStartFrames;
  const text = `${cause}（${frames} 帧音频）`;
  console.error(`[cast-session] ended: ${text}`);
  updateExtensions('session', { lastEndCause: text, lastEndAt: Date.now() });
}

const deviceSession = new DeviceSession({
  config,
  hooks: {
    startSession(mode, kind, initialSamples) {
      sessionStartFrames = hostSession.totalFrames;
      hostSession.begin(mode, initialSamples);
      updateExtensions('session', { mode, phase: deviceSession.phase, gesture: kind, accepted: false, lastEndCause: null });
      emitState('connected');
    },
    stopSession(reason, options) {
      noteEndCause(options?.cancel ? `${reason}(cancel)` : reason);
      hostSession.end(reason, options);
      updateExtensions('session', { mode: null, phase: 'idle', gesture: null, accepted: false, lastStopReason: reason });
      emitState('connected');
    },
    sendCommand(command) {
      send({ type: 'command', command, requestId: randomUUID(), timestampMs: Date.now() });
    },
    writeDevice(bytes) {
      void transport.writeCommand(bytes);
    },
    onAudio(samples) {
      hostSession.feed(samples);
    },
    onStatus(info) {
      if (info.sessionAccepted) {
        updateExtensions('session', { accepted: true });
        emitState('recording');
      } else if (info.sessionRejected) {
        updateExtensions('session', { mode: null, phase: 'idle', accepted: false, lastReject: String(info.sessionRejected) });
        emitState('connected');
      } else if (info.phase) {
        updateExtensions('session', { phase: info.phase });
        emitState('connected');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// HID uses the plugin's native helper in auto/iohid mode. Host BLE owns ATVV
// voice; standard HID over GATT is an explicit diagnostic option only. A GATT
// subscription acknowledgement never disables the native button source.

const hidHelper = new HidHelperSource({
  helperPath,
  buildArgs: () => (config.hidSuppressNative ? ['--seize'] : ['--observe']),
  onReport(bytes) {
    if (!started || config.hidSource === 'gatt') return;
    const edges = hidParser.feed(bytes);
    if (edges.length && (!extensionState.device.hidAvailable || extensionState.device.hidSource !== 'io-kit 助手')) {
      updateExtensions('device', { hidAvailable: true, hidSource: 'io-kit 助手', hidError: null });
      emitState(extensionState.device.connected ? 'connected' : 'starting');
    }
    for (const edge of edges) deviceSession.hidEvent(edge);
  },
  onInfo(message) {
    // Opening a device or starting the process does not prove reports arrive.
    if (message.type === 'started') {
      hidParser.reset();
      const seized = message.seize === true;
      updateExtensions('device', {
        hidSeizeFallback: config.hidSuppressNative && !seized,
        hidSeized: seized,
        hidAvailable: false,
        hidError: '等待遥控器按键报文'
      });
    } else if (message.type === 'device') {
      updateExtensions('device', { hidCollectionCount: message.collectionCount ?? null });
      if (message.connected === false) {
        hidParser.reset();
        updateExtensions('device', { hidAvailable: false, hidError: '等待遥控器 HID 接口连接' });
      } else if (!hidHelper.receiving) {
        updateExtensions('device', { hidError: '等待遥控器按键报文' });
      }
    } else if (message.type === 'permission') {
      updateExtensions('device', { hidInputMonitoring: message.inputMonitoring });
    } else if (message.type === 'error') {
      hidParser.reset();
      updateExtensions('device', { hidAvailable: false, hidError: String(message.message ?? 'HID 读取失败') });
      console.error('[chromecast-remote] hid helper:', JSON.stringify(message));
    } else if (message.type === 'raw_report') {
      const count = (extensionState.device.hidRawReportCount ?? 0) + 1;
      updateExtensions('device', { hidRawReportCount: count, hidLastRawReport: message });
      if (count <= 20) console.error('[cast-hid] raw:', JSON.stringify(message));
    } else if (message.type === 'collection') {
      console.error('[chromecast-remote] hid collection:', JSON.stringify(message));
      return;
    } else {
      return;
    }
    emitState(extensionState.device.connected ? 'connected' : 'starting');
  },
  onStatus(info) {
    hidParser.reset();
    if (info.running) {
      updateExtensions('device', {
        hidAvailable: false, hidSource: 'io-kit 助手', hidError: '等待遥控器按键报文',
        hidSeized: false, hidSeizeFallback: false, hidCollectionCount: 0, hidInputMonitoring: null,
        hidRawReportCount: 0, hidLastRawReport: null
      });
    } else {
      const viaGatt = config.hidSource === 'gatt' && transport.hidSubscribed === true;
      updateExtensions('device', {
        hidAvailable: viaGatt,
        hidSource: viaGatt ? 'gatt' : null,
        hidError: info.error ?? null,
        hidSeized: false, hidSeizeFallback: false, hidCollectionCount: 0, hidInputMonitoring: null,
        hidRawReportCount: 0, hidLastRawReport: null
      });
    }
    emitState(extensionState.device.connected ? 'connected' : 'starting');
  }
});

// ---------------------------------------------------------------------------
// BLE transport through the Host adapter.

const transport = new BleTransport({
  send,
  subscribeHid: config.hidSource === 'gatt',
  onReady({ deviceId, name, atvv, hidSubscribed }) {
    deviceSession.deviceReady({ name, atvv, hidSubscribed });
    hidParser.reset();
    const viaGatt = config.hidSource === 'gatt' && hidSubscribed === true;
    const viaHelper = !viaGatt && hidHelper.receiving;
    updateExtensions('device', {
      connected: true,
      bleDeviceId: deviceId,
      name: name ?? null,
      atvvVersion: atvv.version,
      codec: `ADPCM ${atvv.sampleRate / 1000} kHz`,
      sampleRate: atvv.sampleRate,
      hidAvailable: viaGatt || viaHelper,
      hidSource: viaGatt ? 'gatt' : config.hidSource !== 'gatt' ? 'io-kit 助手' : null
    });
    if (viaGatt || viaHelper) updateExtensions('device', { hidError: null });
    updateExtensions('bluetooth', { phase: 'connected', cause: null, retryInMs: null });
    updateExtensions('session', { mode: null, phase: 'idle', gesture: null, accepted: false });
    emitState('connected');
  },
  onNotification({ characteristicUuid, data }) {
    if (uuidEquals(characteristicUuid, ATVV_CONTROL_UUID) || uuidEquals(characteristicUuid, ATVV_COMMAND_UUID)) {
      deviceSession.controlEvent(parseControlEvent(data, deviceSession.atvv));
    } else if (uuidEquals(characteristicUuid, ATVV_AUDIO_UUID)) {
      deviceSession.audioData(data);
    } else if (config.hidSource === 'gatt' && transport.hidSubscribed && uuidEquals(characteristicUuid, HID_REPORT_UUID)) {
      for (const edge of hidParser.feed(data)) deviceSession.hidEvent(edge);
    }
  },
  onDeviceLost(reason) {
    deviceSession.deviceLost(); // ends any active session (session_cancel)
    if (config.hidSource === 'gatt') hidParser.reset();
    updateExtensions('device', {
      connected: false, bleDeviceId: null,
      hidAvailable: config.hidSource !== 'gatt' && hidHelper.receiving,
      hidSource: config.hidSource !== 'gatt' ? 'io-kit 助手' : null
    });
    updateExtensions('bluetooth', { phase: 'scanning', cause: `设备断开：${reason}` });
    updateExtensions('session', { mode: null, phase: 'idle', gesture: null, accepted: false });
    emitState('starting');
  },
  onStatus(info) {
    if (info.requestFailure) {
      console.error('[cast-ble] request failed:', JSON.stringify(info.requestFailure));
      updateExtensions('bluetooth', { lastRequestFailure: info.requestFailure });
      emitState(extensionState.device.connected ? 'connected' : 'starting');
      return;
    }
    if (info.phase === 'error') {
      updateExtensions('bluetooth', { phase: 'error', cause: info.message, retryInMs: null });
      updateExtensions('device', { connected: false });
      emitState('error');
      return;
    }
    const cause = info.cause ?? null;
    if (info.hidAvailable === false) {
      // Explicit GATT mode never silently switches to a native source.
      const viaHelper = hidHelper.receiving;
      updateExtensions('device', {
        hidAvailable: viaHelper,
        hidSource: viaHelper ? 'io-kit 助手' : null,
        hidError: viaHelper ? null : (extensionState.device.hidError ?? info.hidError ?? 'HID 通知不可用')
      });
    }
    if (info.selectedDeviceId !== undefined) {
      console.error('[cast-ble] selection:', JSON.stringify(info));
      updateExtensions('bluetooth', { selectedDeviceId: info.selectedDeviceId, selectedDeviceName: info.selectedDeviceName });
    }
    updateExtensions('bluetooth', { ...(info.phase ? { phase: info.phase } : {}), cause, retryInMs: info.retryInMs ?? null });
    emitState(info.phase === 'connected' ? 'connected' : 'starting');
  }
});

// ---------------------------------------------------------------------------
// Host lifecycle and message routing.

function optionalRequestId(message) {
  if (typeof message?.requestId !== 'string') return null;
  return message.requestId.trim() ? message.requestId : null;
}

// Obsolete keys from earlier builds. They are dropped silently instead of
// rejected: the Host re-sends the persisted configuration on every connect
// and a rejection would block the plugin start, so legacy payloads must
// still be acknowledged.
const LEGACY_CONFIG_KEYS = ['holdThresholdMs', 'tapMode', 'holdMode'];
const CONFIG_KEYS = ['voiceMode', 'hidSource', 'hidSuppressNative'];

function validateConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'config 必须是对象' };
  }
  const next = { ...config };
  for (const key of LEGACY_CONFIG_KEYS) {
    if (value[key] !== undefined) {
      console.error(`[chromecast-remote] ignoring obsolete config key: ${key}`);
      delete value[key];
    }
  }
  if (value.voiceMode !== undefined) {
    if (value.voiceMode !== 'hold' && value.voiceMode !== 'tap') {
      return { error: 'voiceMode 必须是 hold（长按/PTT）或 tap（短按/免提）' };
    }
    next.voiceMode = value.voiceMode;
  }
  if (value.hidSource !== undefined) {
    if (!['auto', 'gatt', 'iohid'].includes(value.hidSource)) {
      return { error: 'hidSource 必须是 auto、gatt 或 iohid' };
    }
    next.hidSource = value.hidSource;
  }
  if (value.hidSuppressNative !== undefined) {
    if (typeof value.hidSuppressNative !== 'boolean') {
      return { error: 'hidSuppressNative 必须是布尔值' };
    }
    next.hidSuppressNative = value.hidSuppressNative;
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.includes(key)) {
      return { error: `不支持的配置项：${key}` };
    }
  }
  return { value: next };
}

function cleanupForStop() {
  const hadSession = deviceSession.teardown(); // sends MIC_CLOSE when streaming
  if (hadSession) hostSession.end('plugin_stopped', { cancel: true });
  transport.stop();
  hidHelper.stop();
  updateExtensions('device', { connected: false });
  updateExtensions('bluetooth', { phase: 'idle', cause: null, retryInMs: null });
  updateExtensions('session', { mode: null, phase: 'idle', gesture: null, accepted: false });
}

function handleHostMessage(message) {
  if (transport.handleHostMessage(message)) return;

  switch (message.type) {
    case 'initialize':
      return send({ type: 'initialized' });

    case 'start': {
      if (started) return send({ type: 'ready' }); // idempotent re-ack
      started = true;
      updateExtensions('bluetooth', { phase: 'scanning', cause: 'started' });
      emitState('starting');
      transport.start();
      if (config.hidSource !== 'gatt') void hidHelper.start();
      return send({ type: 'ready' });
    }

    case 'stop':
      started = false;
      cleanupForStop();
      emitState('stopped');
      return send({ type: 'stopped' });

    case 'shutdown':
      started = false;
      cleanupForStop();
      send({ type: 'destroyed' });
      emitState('stopped');
      return socket.close();

    case 'configure':
    case 'configuration_changed': {
      const requestId = optionalRequestId(message);
      const result = validateConfig(message.config ?? {});
      if (result.error) {
        // Rejection keeps the previous runtime configuration untouched.
        return send({ type: 'configuration_rejected', ...(requestId ? { requestId } : {}), error: result.error });
      }
      const previous = config;
      config = result.value;
      deviceSession.setConfig(config);
      // Changing the native/GATT choice requires a new subscription lifecycle.
      transport.subscribeHid = config.hidSource === 'gatt';
      if (started && (config.hidSource === 'gatt') !== (previous.hidSource === 'gatt')) {
        deviceSession.deviceLost();
        hidParser.reset();
        transport.stop();
        updateExtensions('device', { connected: false, bleDeviceId: null, hidAvailable: false });
        transport.start(); // waits for the old backend link to finish releasing
      }
      // Keep the helper aligned with the new settings.
      if (config.hidSource === 'gatt') {
        hidHelper.stop();
      } else if (!hidHelper.running && started) {
        void hidHelper.start();
      } else if (started && hidHelper.running && config.hidSuppressNative !== previous.hidSuppressNative) {
        hidHelper.stop(); // restart with the new seize/observe argument
        void hidHelper.start();
      }
      updateExtensions('settings', {
        voiceMode: config.voiceMode,
        hidSource: config.hidSource,
        hidSuppressNative: config.hidSuppressNative
      });
      // Emit immediately so the settings page's next getState reflects the
      // new values without waiting for an unrelated state change.
      emitState(extensionState.device.connected ? 'connected' : 'starting');
      return send({ type: 'configured', ...(requestId ? { requestId } : {}) });
    }

    case 'session_accepted':
      if (hostSession.accepted(message.requestId)) deviceSession.sessionAccepted();
      return;

    case 'session_rejected':
      if (hostSession.rejected(message.requestId)) {
        noteEndCause(`rejected:${message.reason ?? 'rejected'}`);
        deviceSession.sessionRejected(message.reason ?? 'rejected');
        updateExtensions('session', { mode: null, phase: 'idle', accepted: false });
        emitState('connected');
      }
      return;

    case 'session_state':
      if (message.state === 'success' || message.state === 'error') {
        if (hostSession.hostEnded(message.requestId)) {
          noteEndCause(`host_${message.state}`);
          deviceSession.hostSessionEnded();
          updateExtensions('session', { mode: null, phase: 'idle', accepted: false, lastHostState: message.state });
          emitState('connected');
        }
      }
      return;

    default:
      return;
  }
}

socket = new WebSocket(wsUrl);
socket.addEventListener('open', () => send({ type: 'plugin_hello', token, manifest }));
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return;
  try {
    handleHostMessage(JSON.parse(event.data));
  } catch (error) {
    console.error('[chromecast-remote] host message error:', error.message);
  }
});
socket.addEventListener('close', () => {
  // The Host releases BLE ownership on socket close; just exit cleanly. The
  // helper exits by itself on stdin EOF.
  transport.stop();
  deviceSession.stop();
  hidHelper.stop();
  setImmediate(() => process.exit(0));
});
socket.addEventListener('error', (error) => {
  console.error('[chromecast-remote] plugin websocket:', error.message ?? error);
});
