// End-to-end tests: the real worker process against a fake Vokie Host and a
// fake Chromecast Voice Remote simulated through the Host BLE adapter
// messages. Covers handshake, lifecycle, both voice-key modes (hold = ptt,
// tap = handsfree-ptt), mode switching via configuration, audio frames, HID
// commands from GATT and from the IOKit helper, and cleanup — no physical
// device required.

import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidEquals } from '../worker/ble-transport.mjs';
import {
  ATVV,
  FakePluginHost,
  FakeHciDaemon,
  audioStartHost,
  audioStartPhysical,
  audioStopPhysical,
  capabilitiesV10,
  hidReport,
  nhdrBackDown,
  nhdrButtonUp,
  nhdrSelectDown,
  parseAudioFrame
} from './helpers.mjs';

const workerEntry = fileURLToPath(new URL('../worker/index.mjs', import.meta.url));
const manifestPath = fileURLToPath(new URL('../vokie.plugin.json', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notification(host, characteristicUuid, bytes) {
  host.sendJson({
    type: 'ble_notification',
    deviceId: DEVICE_ID,
    characteristicUuid,
    dataBase64: Buffer.from(bytes).toString('base64')
  });
}

const DEVICE_ID = 'fake-chromecast-1';

async function startWorker(host, extraEnv = {}) {
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      VOKIE_PLUGIN_WS_URL: `ws://127.0.0.1:${host.port}`,
      VOKIE_PLUGIN_TOKEN: 'one-time-token',
      // Tests must not open real HID devices, trigger system permission UI,
      // or reach the real privileged HCI daemon (a capture start would reload
      // the machine's bluetoothd).
      VOKIE_HID_HELPER: '/nonexistent/test-hid-helper',
      VOKIE_IDENTITY_HELPER: '/nonexistent/test-identity-helper',
      VOKIE_HCI_SOCKET: '/nonexistent/test-hci.sock',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[worker] ${chunk}`));
  return child;
}

/** Drive the adapter handshake until the remote is connected. */
async function connectRemote(host, includeHid = true) {
  const scan = await host.waitFor((m) => m.type === 'ble_scan', 'ble_scan');
  host.sendJson({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: DEVICE_ID, name: 'Chromecast Remote', serviceUuids: [ATVV.service], rssi: -42 }]
  });
  const connect = await host.waitFor((m) => m.type === 'ble_connect', 'ble_connect');
  host.sendJson({ type: 'ble_accepted', requestId: connect.requestId });
  for (const characteristic of [ATVV.control, ATVV.audio, ...(includeHid ? [ATVV.hidReport] : []), ATVV.command]) {
    const notify = await host.waitFor(
      (m) => m.type === 'ble_start_notify' && uuidEquals(m.characteristicUuid, characteristic),
      `notify ${characteristic}`
    );
    host.sendJson({ type: 'ble_accepted', requestId: notify.requestId });
  }
  const write = await host.waitFor((m) => m.type === 'ble_write', 'getCapabilities write');
  assert.deepEqual([...Buffer.from(write.dataBase64, 'base64')], [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]);
  host.sendJson({ type: 'ble_accepted', requestId: write.requestId });
  notification(host, ATVV.control, capabilitiesV10());
  await host.waitFor((m) => m.type === 'state' && m.state === 'connected', 'state connected');
}

test('full lifecycle: handshake, hold mode, tap mode, commands, config, stop, shutdown', async () => {
  const host = new FakePluginHost();
  await host.listen();
  const child = await startWorker(host);
  try {
    // --- Handshake: plugin_hello first, echoing the on-disk manifest.
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'plugin_hello');
    assert.equal(host.messages[0].type, 'plugin_hello');
    assert.equal(hello.token, 'one-time-token');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const field of ['id', 'name', 'version', 'apiVersion', 'platforms', 'transports', 'capabilities', 'permissions', 'icon', 'ui']) {
      assert.deepEqual(hello.manifest[field], manifest[field], `manifest field ${field} must match vokie.plugin.json`);
    }
    host.sendJson({ type: 'handshake_ok', pluginId: manifest.id, connectionId: 'conn-1' });

    host.sendJson({ type: 'initialize' });
    await host.waitFor((m) => m.type === 'initialized', 'initialized');

    // Host pushes persisted configuration before start.
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-1', config: { hidSource: 'gatt' } });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-1', 'configured cfg-1');

    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');
    await host.waitFor((m) => m.type === 'state' && m.state === 'starting', 'state starting');

    await connectRemote(host);
    const stateConnected = host.messages.find((m) => m.type === 'state' && m.state === 'connected');
    assert.equal(stateConnected.extensions.device.name, 'Chromecast Remote');
    assert.equal(stateConnected.extensions.device.atvvVersion, '1.0');
    assert.equal(stateConnected.extensions.device.hidAvailable, true);
    assert.equal(stateConnected.extensions.settings.voiceMode, 'hold');

    // --- Hold mode (default): the key IS push-to-talk. A press starts the
    // ptt session immediately (no threshold); release stops it — even a
    // quick tap is just a very short session.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 6 }));
    await delay(150);
    notification(host, ATVV.control, audioStopPhysical());
    const briefStart = await host.waitFor((m) => m.type === 'session_start' && m.mode === 'ptt', 'brief ptt session_start');
    host.sendJson({ type: 'session_accepted', requestId: briefStart.requestId, sessionId: 's-0', mode: 'ptt' });
    await host.waitFor((m) => m.type === 'session_stop' && m.requestId === briefStart.requestId, 'brief session stops at release');

    // --- Hold mode: press -> talk -> release, with buffered pre-acceptance
    // audio flushed after acceptance.
    const briefStopIndex = host.messages.findIndex((m) => m.type === 'session_stop' && m.requestId === briefStart.requestId);
    notification(host, ATVV.control, audioStartPhysical({ streamId: 10 }));
    notification(host, ATVV.audio, Uint8Array.of(0x77)); // arrives during the acceptance round-trip
    // The session must start at key-down, not after any threshold delay.
    const holdStart = await host.waitFor(
      (m) => m.type === 'session_start' && m.mode === 'ptt',
      'ptt session_start at key-down',
      300, // well below the removed 550 ms threshold
      briefStopIndex + 1 // exclude the brief session's own start
    );
    host.sendJson({ type: 'session_accepted', requestId: holdStart.requestId, sessionId: 's-1', mode: 'ptt' });
    // Pre-acceptance audio [11, 41] is flushed first.
    const holdFrame = await host.waitFor((m) => m.type === 'audio_frame' && m.header.requestId === holdStart.requestId, 'hold audio frame');
    assert.deepEqual([...holdFrame.pcm], [0x0b, 0x00, 0x29, 0x00]);
    notification(host, ATVV.control, audioStopPhysical());
    await host.waitFor((m) => m.type === 'session_stop' && m.requestId === holdStart.requestId, 'hold session_stop');
    await host.waitFor(
      (m) => m.type === 'ble_write' && Buffer.from(m.dataBase64, 'base64')[0] === 0x0d,
      'micClose after hold'
    );

    // --- Switch to tap mode.
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-2', config: { voiceMode: 'tap' } });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-2', 'configured cfg-2');

    // --- Tap mode: ANY press duration toggles (no threshold). A slow press
    // (700 ms, above the hold threshold) still opens the session.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 8 }));
    await delay(700); // beyond the 550 ms threshold — still a toggle press
    notification(host, ATVV.control, audioStopPhysical());
    const slowToggleStart = await host.waitFor((m) => m.type === 'session_start' && m.mode === 'handsfree-ptt', 'slow toggle session_start');
    const slowMicOpen = await host.waitFor(
      (m) => m.type === 'ble_write' && Buffer.from(m.dataBase64, 'base64')[0] === 0x0c,
      'micOpen write (slow toggle)'
    );
    host.sendJson({ type: 'ble_accepted', requestId: slowMicOpen.requestId });
    host.sendJson({ type: 'session_accepted', requestId: slowToggleStart.requestId, sessionId: 's-2a', mode: 'handsfree-ptt' });
    notification(host, ATVV.control, audioStartHost({ streamId: 9 }));
    // Toggle off again with a quick press.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 10 }));
    await delay(150);
    notification(host, ATVV.control, audioStopPhysical());
    await host.waitFor((m) => m.type === 'session_stop' && m.requestId === slowToggleStart.requestId, 'slow toggle session_stop');
    await host.waitFor(
      (m) => m.type === 'ble_write' && Buffer.from(m.dataBase64, 'base64')[0] === 0x0d,
      'micClose write (slow toggle)',
      5000,
      host.messages.findIndex((m) => m.requestId === slowMicOpen.requestId) + 1
    );

    // --- Tap mode: a quick tap opens a handsfree-ptt session with a persistent mic.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 7 }));
    notification(host, ATVV.audio, Uint8Array.of(0x77, 0x00)); // tap audio
    await delay(200);
    notification(host, ATVV.control, audioStopPhysical());

    const tapStart = await host.waitFor(
      (m) => m.type === 'session_start' && m.mode === 'handsfree-ptt',
      'handsfree session_start',
      5000,
      host.messages.findIndex((m) => m.requestId === slowToggleStart.requestId) + 1
    );
    assert.deepEqual(tapStart.options.audioSource, { type: 'stream', format: 'pcm_s16le', sampleRate: 16000, channels: 1 });
    const micOpen = await host.waitFor(
      (m) => m.type === 'ble_write' && Buffer.from(m.dataBase64, 'base64')[0] === 0x0c,
      'micOpen write',
      5000,
      host.messages.findIndex((m) => m.requestId === slowMicOpen.requestId) + 1
    );
    assert.deepEqual([...Buffer.from(micOpen.dataBase64, 'base64')], [0x0c, 0x00]);
    host.sendJson({ type: 'ble_accepted', requestId: micOpen.requestId });
    host.sendJson({ type: 'session_accepted', requestId: tapStart.requestId, sessionId: 's-2', mode: 'handsfree-ptt' });
    await host.waitFor(
      (m) => m.type === 'state' && m.state === 'recording',
      'state recording',
      5000,
      host.messages.findIndex((m) => m.requestId === tapStart.requestId) + 1
    );

    // Persistent stream confirmed + live audio -> ordered binary frames.
    notification(host, ATVV.control, audioStartHost({ streamId: 13 }));
    const frame1 = await host.waitFor((m) => m.type === 'audio_frame' && m.header.requestId === tapStart.requestId, 'first audio frame');
    assert.equal(frame1.header.sequence, 0);
    assert.equal(frame1.header.sampleRate, 16000);
    // Buffered tap audio [11, 41, 45, 48] is flushed first (little-endian s16).
    assert.deepEqual([...frame1.pcm], [0x0b, 0x00, 0x29, 0x00, 0x2d, 0x00, 0x30, 0x00]);
    // The persistent stream restarts the decoder; same nibbles, same samples.
    notification(host, ATVV.audio, Uint8Array.of(0x77, 0x00));
    const frame2 = await host.waitFor((m) => m.type === 'audio_frame' && m.header.sequence === 1, 'second audio frame');
    assert.deepEqual([...frame2.pcm], [0x0b, 0x00, 0x29, 0x00, 0x2d, 0x00, 0x30, 0x00]);
    // Continued stream decodes with running state: [51, 54].
    notification(host, ATVV.audio, Uint8Array.of(0x00));
    const frame3 = await host.waitFor((m) => m.type === 'audio_frame' && m.header.sequence === 2, 'third audio frame');
    assert.deepEqual([...frame3.pcm], [0x33, 0x00, 0x36, 0x00]);

    // --- Second tap closes the session.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 11 }));
    await delay(150);
    notification(host, ATVV.control, audioStopPhysical());
    await host.waitFor((m) => m.type === 'session_stop' && m.requestId === tapStart.requestId, 'session_stop');
    const micOpenIndex = host.messages.findIndex((m) => m.requestId === micOpen.requestId);
    const micClose = await host.waitFor(
      (m) => m.type === 'ble_write' && Buffer.from(m.dataBase64, 'base64')[0] === 0x0d,
      'micClose write',
      5000,
      micOpenIndex + 1 // exclude the hold section's earlier MIC_CLOSE
    );
    assert.deepEqual([...Buffer.from(micClose.dataBase64, 'base64')], [0x0d, 0x0b]);
    host.sendJson({ type: 'ble_accepted', requestId: micClose.requestId });

    // --- HID buttons over GATT: select -> send_enter, back -> undo_last_output.
    notification(host, ATVV.hidReport, hidReport(0x07));
    const enter = await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'send_enter');
    assert.ok(enter.requestId);
    notification(host, ATVV.hidReport, hidReport(0x00)); // release
    notification(host, ATVV.hidReport, hidReport(0x0b));
    await host.waitFor((m) => m.type === 'command' && m.command === 'undo_last_output', 'undo_last_output');
    notification(host, ATVV.hidReport, hidReport(0x00));

    // --- Configuration: invalid value rejected, runtime config untouched.
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-3', config: { voiceMode: 'bogus' } });
    const rejected = await host.waitFor((m) => m.type === 'configuration_rejected' && m.requestId === 'cfg-3', 'rejected cfg-3');
    assert.ok(rejected.error.includes('voiceMode'));
    // Legacy keys (tapMode/holdMode/holdThresholdMs) are dropped silently so a
    // persisted old configuration can never block the plugin start.
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-4', config: { tapMode: 'ptt', holdThresholdMs: 550 } });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-4', 'configured cfg-4 with legacy keys');
    const settingsAfterLegacy = host.messages.filter((m) => m.type === 'state').at(-1)?.extensions?.settings;
    assert.equal(settingsAfterLegacy?.voiceMode, 'tap'); // unchanged by the legacy payload

    // --- Device loss mid-session cancels it.
    notification(host, ATVV.control, audioStartPhysical({ streamId: 12 }));
    await delay(200);
    notification(host, ATVV.control, audioStopPhysical());
    const tapStart3 = await host.waitFor(
      (m) => m.type === 'session_start',
      'third session',
      5000,
      host.messages.findIndex((m) => m.requestId === 'cfg-4') + 1
    );
    host.sendJson({ type: 'session_accepted', requestId: tapStart3.requestId, sessionId: 's-3', mode: 'handsfree-ptt' });
    await delay(100);
    host.sendJson({ type: 'ble_disconnected', deviceId: DEVICE_ID, reason: 'link_lost' });
    await host.waitFor((m) => m.type === 'session_cancel' && m.requestId === tapStart3.requestId, 'session_cancel on device loss');
    const cancelIndex = host.messages.findIndex((m) => m.type === 'session_cancel' && m.requestId === tapStart3.requestId);
    await host.waitFor((m) => m.type === 'state' && m.state === 'starting', 'back to scanning', 5000, cancelIndex + 1);
    // The end cause is surfaced in extensions for the settings page.
    const afterLoss = host.messages
      .slice(cancelIndex)
      .filter((m) => m.type === 'state')
      .at(-1);
    assert.ok(afterLoss.extensions.session.lastEndCause.includes('device_lost'), afterLoss.extensions.session.lastEndCause);

    // --- stop: clean device release, stopped ack.
    host.sendJson({ type: 'stop', reason: 'user' });
    await host.waitFor((m) => m.type === 'stopped', 'stopped ack');
    await host.waitFor((m) => m.type === 'state' && m.state === 'stopped', 'state stopped');

    // --- restart + shutdown: destroyed + socket close + process exit.
    host.sendJson({ type: 'start' });
    const stoppedIndex = host.messages.map((m) => m.type).lastIndexOf('stopped');
    await host.waitFor((m) => m.type === 'ready', 'ready after restart', 5000, stoppedIndex + 1);
    host.sendJson({ type: 'shutdown' });
    await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await exited;
  } finally {
    child.kill('SIGKILL');
    await host.close();
  }
});

test('IOKit helper: buttons work without any BLE link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helper-e2e-'));
  try {
    const selectReport = Buffer.from(Uint8Array.of(0x01, 0x07)).toString('base64');
    const helperPath = join(dir, 'fake-hid-helper.mjs');
    await writeFile(
      helperPath,
      '#!/usr/bin/env node\n' +
        'process.stdin.resume();\n' +
        'process.stdin.on("end", () => process.exit(0));\n' +
        `process.stdout.write(JSON.stringify({ type: "hid_report", data: ${JSON.stringify(selectReport)} }) + "\\n");\n` +
        'setInterval(() => {}, 60000);\n',
      'utf8'
    );
    await chmod(helperPath, 0o755);

    const host = new FakePluginHost();
    await host.listen();
    const child = await startWorker(host, { VOKIE_HID_HELPER: helperPath });
    try {
      const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'plugin_hello');
      host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'conn-2' });
      host.sendJson({ type: 'initialize' });
      await host.waitFor((m) => m.type === 'initialized', 'initialized');
      host.sendJson({ type: 'configuration_changed', requestId: 'cfg-1', config: {} });
      await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-1', 'configured');
      host.sendJson({ type: 'start' });
      await host.waitFor((m) => m.type === 'ready', 'ready');

      // The helper is spawned at start; its report becomes a send_enter
      // command even though no BLE device ever connects.
      const enter = await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'send_enter from helper');
      assert.ok(enter.requestId);

      // Extensions report the helper as the button source.
      const state = host.messages.filter((m) => m.type === 'state').at(-1);
      assert.equal(state.extensions.device.hidAvailable, true);
      assert.equal(state.extensions.device.hidSource, 'io-kit 助手');

      host.sendJson({ type: 'shutdown' });
      await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
      const exited = new Promise((resolve) => child.on('exit', resolve));
      await exited;
      // The helper exits on stdin EOF once the worker is gone.
      await delay(300);
    } finally {
      child.kill('SIGKILL');
      await host.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HCI capture: buttons work without any BLE link (the macOS 26.5 path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-e2e-'));
  const daemon = new FakeHciDaemon();
  await daemon.listen(join(dir, 'hci.sock'));
  const host = new FakePluginHost();
  let child;
  try {
    await host.listen();
    child = await startWorker(host, { VOKIE_HCI_SOCKET: join(dir, 'hci.sock') });
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'hci-e2e' });
    host.sendJson({ type: 'initialize' });
    await host.waitFor((m) => m.type === 'initialized', 'initialized');
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-1', config: { hidSource: 'hci' } });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-1', 'configured');
    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');

    // The capture starts even though no BLE device ever connects.
    await host.waitFor((m) =>
      m.type === 'state' && m.extensions.device.hciPhase === 'capturing' &&
      m.extensions.device.hidSeized === true,
    'hci capturing with HID seized');
    const request = daemon.requests.find((item) => item.command === 'startCapture');
    assert.ok(request, 'worker sent startCapture to the daemon');
    assert.equal(request.protocol, 'vokie.appleTvRemote.hci');
    assert.equal(request.requiredVersion, '4');
    const seize = daemon.requests.find((item) => item.command === 'seizeHid');
    assert.equal(seize.vendorId, 0x18d1);
    assert.equal(seize.productId, 0x9450);

    const afterCapture = host.messages.length;
    daemon.stopCapture();
    const retrying = await host.waitFor((m) =>
      m.type === 'state' && m.extensions.device.hciPhase === 'retrying',
    'hci retrying after capture stopped', 5000, afterCapture);
    assert.equal(retrying.extensions.device.hidSeized, false);
    assert.equal(retrying.extensions.device.hidSeizeError, null);
    await host.waitFor((m) =>
      m.type === 'state' && m.extensions.device.hciPhase === 'capturing' &&
      m.extensions.device.hidSeized === true,
    'hci recaptured with HID seized', 5000, afterCapture);

    // 确认键 → send_enter，返回键 → undo_last_output；松开不产生命令。
    daemon.sendNhdr(nhdrSelectDown());
    const enter = await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'send_enter from hci');
    assert.ok(enter.requestId);
    daemon.sendNhdr(nhdrBackDown());
    await host.waitFor((m) => m.type === 'command' && m.command === 'undo_last_output', 'undo_last_output from hci');
    daemon.sendNhdr(nhdrButtonUp());
    await delay(150);
    assert.equal(host.messages.filter((m) => m.type === 'command').length, 2);

    const state = host.messages.filter((m) => m.type === 'state').at(-1);
    assert.equal(state.extensions.device.hidAvailable, true);
    assert.equal(state.extensions.device.hidSource, 'hci 抓包');
    assert.equal(state.extensions.device.hciButtonCount, 4); // down×2 + up×2 edges

    host.sendJson({
      type: 'configuration_changed',
      requestId: 'cfg-no-seize',
      config: { hidSuppressNative: false }
    });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-no-seize', 'disable HID seize');
    await delay(100);
    assert.equal(daemon.seized, false, 'daemon released HID seize');
    assert.equal(daemon.capturing, true, 'capture stays active after releasing HID');

    // Stop releases the privileged capture.
    host.sendJson({ type: 'stop' });
    await host.waitFor((m) => m.type === 'stopped', 'stopped');
    await delay(150);
    assert.equal(daemon.capturing, false);
    assert.equal(daemon.sockets.length, 0);

    host.sendJson({ type: 'shutdown' });
    await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await exited;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HCI capture: HID seizure failure is exposed in extension state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-seize-failure-'));
  const daemon = new FakeHciDaemon({ seizeAllowed: false });
  await daemon.listen(join(dir, 'hci.sock'));
  const host = new FakePluginHost();
  let child;
  try {
    await host.listen();
    child = await startWorker(host, { VOKIE_HCI_SOCKET: join(dir, 'hci.sock') });
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'hci-seize-failure' });
    host.sendJson({ type: 'initialize' });
    await host.waitFor((m) => m.type === 'initialized', 'initialized');
    host.sendJson({ type: 'configuration_changed', requestId: 'cfg-1', config: { hidSource: 'hci' } });
    await host.waitFor((m) => m.type === 'configured' && m.requestId === 'cfg-1', 'configured');
    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');

    const state = await host.waitFor((m) =>
      m.type === 'state' && m.extensions.device.hciPhase === 'capturing' &&
      m.extensions.device.hidSeizeError === 'HID seize unavailable',
    'HID seizure failure');
    assert.equal(state.extensions.device.hidSeized, false);

    host.sendJson({ type: 'shutdown' });
    await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await exited;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto mode: the HCI daemon serves buttons and the IOKit helper stays off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-auto-'));
  const daemon = new FakeHciDaemon();
  await daemon.listen(join(dir, 'hci.sock'));
  const host = new FakePluginHost();
  let child;
  try {
    await host.listen();
    // The IOKit helper is deliberately missing: with HCI capturing, the
    // fallback must never be spawned.
    child = await startWorker(host, {
      VOKIE_HCI_SOCKET: join(dir, 'hci.sock'),
      VOKIE_HID_HELPER: '/nonexistent/test-hid-helper'
    });
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'hci-auto' });
    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');
    await host.waitFor((m) => m.type === 'state' && m.extensions.device.hciPhase === 'capturing', 'hci capturing');

    daemon.sendNhdr(nhdrSelectDown());
    await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'send_enter in auto');
    const state = host.messages.filter((m) => m.type === 'state').at(-1);
    assert.equal(state.extensions.device.hidSource, 'hci 抓包');
    assert.equal(state.extensions.device.hidError, null);

    host.sendJson({ type: 'shutdown' });
    await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await exited;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto mode: missing HCI daemon falls back to the IOKit helper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-fallback-'));
  const host = new FakePluginHost();
  let child;
  try {
    await host.listen();
    // Both the daemon socket and a real helper are unavailable: auto must
    // report the definitive HCI failure and fall back to the (missing)
    // helper without crashing or retrying forever.
    child = await startWorker(host, {
      VOKIE_HCI_SOCKET: '/nonexistent/test-hci.sock',
      VOKIE_HID_HELPER: '/nonexistent/test-hid-helper'
    });
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'hci-fallback' });
    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');
    const fallback = await host.waitFor(
      (m) => m.type === 'state' && /回退 IOKit 助手/.test(m.extensions.device.hidError ?? ''),
      'fallback state'
    );
    assert.equal(fallback.extensions.device.hciPhase, 'stopped');
    assert.equal(fallback.extensions.device.hidAvailable, false);

    host.sendJson({ type: 'shutdown' });
    await host.waitFor((m) => m.type === 'destroyed', 'destroyed');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await exited;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest files resolve and worker has no Electron dependency', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packageRoot = new URL('../', import.meta.url);
  for (const relative of [manifest.icon, manifest.ui.entrypoint, manifest.worker.entrypoint]) {
    const url = new URL(relative, packageRoot);
    await readFile(url, 'utf8'); // throws when the path does not resolve
  }
  const workerSource = await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  assert.equal(/electron|require\(|pluginPresenter/i.test(workerSource), false);
});

test('IOKit helper: reports, not process startup, establish availability; reconnect resets key state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helper-status-'));
  const host = new FakePluginHost();
  let child;
  try {
    const inputPath = join(dir, 'events.jsonl');
    const helperPath = join(dir, 'helper.mjs');
    await writeFile(inputPath, '');
    await writeFile(helperPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
let cursor = 0;
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
  const text = readFileSync(${JSON.stringify(inputPath)}, 'utf8');
  const end = text.lastIndexOf('\\n') + 1;
  if (end > cursor) { process.stdout.write(text.slice(cursor, end)); cursor = end; }
}, 10);
`);
    await chmod(helperPath, 0o755);
    await host.listen();
    child = await startWorker(host, { VOKIE_HID_HELPER: helperPath });
    const hello = await host.waitFor((m) => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'handshake_ok', pluginId: hello.manifest.id, connectionId: 'helper-status' });
    host.sendJson({ type: 'start' });
    await host.waitFor((m) => m.type === 'ready', 'ready');
    const startup = await host.waitFor((m) => m.type === 'state' && m.extensions.device.hidSource === 'io-kit 助手', 'helper spawn');
    assert.equal(startup.extensions.device.hidAvailable, false);

    async function event(message, predicate) {
      const from = host.messages.length;
      await appendFile(inputPath, JSON.stringify(message) + '\n');
      return host.waitFor((m) => m.type === 'state' && predicate(m.extensions.device), message.type, 5000, from);
    }
    await event({ type: 'permission', inputMonitoring: 'denied' }, (d) => d.hidInputMonitoring === 'denied');
    await event({ type: 'started', seize: false }, (d) => d.hidSeizeFallback && !d.hidAvailable);
    await event({ type: 'device', connected: true, collectionCount: 2 }, (d) => d.hidCollectionCount === 2 && !d.hidAvailable);
    const report = { type: 'hid_report', data: Buffer.from([0x01, 0x07]).toString('base64') };
    await event(report, (d) => d.hidAvailable && d.hidError === null);
    await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'first key');

    // Losing one collection must leave the other available, and duplicate
    // reports from overlapping collections must not send a second Enter.
    await event({ type: 'device', connected: true, collectionCount: 1 }, (d) => d.hidCollectionCount === 1 && d.hidAvailable);
    await appendFile(inputPath, JSON.stringify(report) + '\n');
    await event({ type: 'permission', inputMonitoring: 'granted' }, (d) => d.hidInputMonitoring === 'granted');
    assert.equal(host.messages.filter((m) => m.type === 'command').length, 1);

    await event({ type: 'device', connected: false, collectionCount: 0 }, (d) => !d.hidAvailable && d.hidCollectionCount === 0);
    await event({ type: 'device', connected: true, collectionCount: 2 }, (d) => d.hidCollectionCount === 2 && !d.hidAvailable);
    const from = host.messages.length;
    await event(report, (d) => d.hidAvailable);
    await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'key after reconnect', 5000, from);
    assert.equal(host.messages.filter((m) => m.type === 'command').length, 2);

    await event({ type: 'error', message: 'IOHIDManagerOpen: 独占访问冲突（0xE00002C5）', recoverable: true },
      (d) => !d.hidAvailable && d.hidError.includes('0xE00002C5'));
    await event({ type: 'started', seize: false }, (d) => !d.hidAvailable && d.hidSeizeFallback);
    await event(report, (d) => d.hidAvailable && d.hidError === null);

    // In auto mode, completing BLE voice setup must neither subscribe GATT
    // HID nor stop the native helper. A further key still comes from helper.
    await connectRemote(host, false);
    assert.equal(host.messages.some((m) => m.type === 'ble_start_notify' && uuidEquals(m.characteristicUuid, ATVV.hidReport)), false);
    await appendFile(inputPath, JSON.stringify({ type: 'hid_report', data: Buffer.from([1, 0]).toString('base64') }) + '\n');
    const afterVoiceReady = host.messages.length;
    await appendFile(inputPath, JSON.stringify(report) + '\n');
    await host.waitFor((m) => m.type === 'command' && m.command === 'send_enter', 'native key after BLE ready', 5000, afterVoiceReady);
    assert.equal(host.messages.filter((m) => m.type === 'state').at(-1).extensions.device.hidSource, 'io-kit 助手');

    host.sendJson({ type: 'stop' });
    await host.waitFor((m) => m.type === 'stopped', 'stopped');
    const state = host.messages.filter((m) => m.type === 'state').at(-1);
    assert.equal(state.extensions.device.hidAvailable, false);
    assert.equal(state.extensions.device.hidSeized, false);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    host.sendJson({ type: 'shutdown' });
    await exited;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('A0 worker: serial-bound HCI buttons, 160-byte ATVV audio and identity cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-plugin-'));
  const daemon = new FakeHciDaemon();
  const host = new FakePluginHost();
  let child;
  try {
    const events = join(dir, 'identity.jsonl');
    const commands = join(dir, 'commands.jsonl');
    const helper = join(dir, 'identity.mjs');
    await writeFile(events, '');
    await writeFile(commands, '');
    await writeFile(helper, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
let cursor = 0;
console.log(JSON.stringify({ type: 'identity_ready' }));
process.stdin.on('data', data => appendFileSync(${JSON.stringify(commands)}, data));
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
  const text = readFileSync(${JSON.stringify(events)}, 'utf8');
  const end = text.lastIndexOf('\\n') + 1;
  if (end > cursor) { process.stdout.write(text.slice(cursor, end)); cursor = end; }
}, 10);
`);
    await chmod(helper, 0o755);
    await daemon.listen(join(dir, 'hci.sock'));
    await host.listen();
    child = await startWorker(host, { VOKIE_HCI_SOCKET: join(dir, 'hci.sock'), VOKIE_IDENTITY_HELPER: helper });
    await host.waitFor(m => m.type === 'plugin_hello', 'hello');
    host.sendJson({ type: 'start' });
    await host.waitFor(m => m.type === 'ready', 'ready');
    await host.waitFor(m => m.type === 'state' && m.extensions.device.hciPhase === 'capturing', 'capture');
    const emitIdentity = message => appendFile(events, JSON.stringify({ deviceId: DEVICE_ID, ...message }) + '\n');
    await emitIdentity({ type: 'identity', connected: true, modelNumber: 'A0', firmwareVersion: '26.2',
      serialNumber: 'A0SERIAL1234', deviceAddress: '47-54-51-45-a5-a8' });
    await host.waitFor(m => m.type === 'state' && m.extensions.device.modelNumber === 'A0', 'A0 model');
    await connectRemote(host, false);
    const state = host.messages.filter(m => m.type === 'state').at(-1).extensions.device;
    assert.equal(state.firmwareVersion, '26.2');
    assert.equal(state.hidAvailable, false);
    // All A0 source forms still require a verified connection handle.
    function trace(value, { direction = 'RECV', handle = 12, source = '00:00:00:00:00:00' } = {}) {
      const bytes = [handle, direction === 'SEND' ? 0 : 0x20, value.length + 4, 0, value.length, 0, 4, 0, ...value];
      return `Sep 15 12:00:00 ${source} 0x000c ${direction} ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`;
    }
    const select = [0x1b, 0x29, 0, 7, 0, 0, 0, 0, 0, 0, 0];
    const up = [0x1b, 0x29, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    daemon.sendNhdr(trace(select));
    daemon.sendNhdr(trace(select, { source: 'Chromecast Remote' }));
    await delay(50);
    assert.equal(host.messages.filter(m => m.type === 'command').length, 0);
    await emitIdentity({ type: 'identity_probe', serialNumber: 'A0SERIAL1234' });
    await delay(50);
    daemon.sendNhdr(trace([0x0a, 0x10, 0], { direction: 'SEND' }));
    daemon.sendNhdr(trace([0x0b, ...Buffer.from('A0SERIAL1234')]));
    await emitIdentity({ type: 'identity_confirm', data: Buffer.from('A0SERIAL1234').toString('base64') });
    await host.waitFor(m => m.type === 'state' && m.extensions.device.hciIdentityVerified, 'verified A0');
    daemon.sendNhdr(trace(select, { handle: 13 }));
    daemon.sendNhdr(trace(select, { source: '00:11:22:33:44:55' }));
    daemon.sendNhdr(trace(select));
    daemon.sendNhdr(trace(select));
    daemon.sendNhdr(trace(up));
    daemon.sendNhdr(trace([0x1b, 0x29, 0, 11, 0, 0, 0, 0, 0, 0, 0], { source: '47:54:51:45:A5:A8' }));
    await host.waitFor(m => m.type === 'command' && m.command === 'undo_last_output', 'A0 back');
    assert.deepEqual(host.messages.filter(m => m.type === 'command').map(m => m.command), ['send_enter', 'undo_last_output']);

    notification(host, ATVV.control, audioStartPhysical({ streamId: 0xa4 }));
    notification(host, ATVV.audio, new Uint8Array(160).fill(0x77));
    const session = await host.waitFor(m => m.type === 'session_start', 'A0 PTT');
    assert.equal(host.binaryFrames.length, 0);
    host.sendJson({ type: 'session_accepted', requestId: session.requestId, sessionId: 'a0', mode: 'ptt' });
    const audio = await host.waitFor(m => m.type === 'audio_frame', 'A0 audio');
    assert.equal(audio.pcm.length, 640); // 160 ADPCM bytes -> 320 PCM16 samples
    notification(host, ATVV.control, audioStopPhysical());
    await host.waitFor(m => m.type === 'session_stop', 'A0 release');

    // Device loss invalidates the binding and held-key state immediately.
    await emitIdentity({ type: 'identity', connected: false });
    await host.waitFor(m => m.type === 'state' && m.extensions.device.identityConnected === false, 'identity removed');
    daemon.sendNhdr(trace(select));
    await delay(50);
    assert.equal(host.messages.filter(m => m.type === 'command').length, 2);
    assert.match(await readFile(commands, 'utf8'), /"verified":true/);
    const exit = new Promise(resolve => child.once('exit', resolve));
    host.sendJson({ type: 'shutdown' });
    await host.waitFor(m => m.type === 'destroyed', 'destroyed');
    await exit;
  } finally {
    child?.kill('SIGKILL');
    await host.close();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});
