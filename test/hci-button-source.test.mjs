// Button capture over the privileged HCI daemon: parser unit tests plus
// source lifecycle tests against a fake daemon socket (never the real
// /var/run/com.vokie.hci.sock — starting a real capture reloads bluetoothd).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  delay,
  FakeHciDaemon,
  nhdrAttLine,
  nhdrBackDown,
  nhdrButtonUp,
  nhdrSelectDown,
  HCI_BUTTON_GATT_HANDLE
} from './helpers.mjs';
import {
  HciButtonSource,
  HciButtonValueParser,
  parseAclBytes,
  parsePacketLoggerLine
} from '../worker/hci-button-source.mjs';

const fastClock = () => ({
  setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
  clearTimer: (handle) => clearTimeout(handle)
});

// ---------------------------------------------------------------------------
// nhdr / ACL parsing

test('nhdr parsing: extracts ATT notifications for the Chromecast Remote', () => {
  assert.deepEqual(parsePacketLoggerLine(nhdrSelectDown()), {
    gattHandle: HCI_BUTTON_GATT_HANDLE,
    value: [0x41, 0x00]
  });
  assert.deepEqual(parsePacketLoggerLine(nhdrBackDown()), {
    gattHandle: HCI_BUTTON_GATT_HANDLE,
    value: [0x24, 0x02]
  });
  // Other GATT handles (ATVV control/audio on the voice link) pass through
  // the channel filter untouched; the button parser ignores them.
  assert.deepEqual(
    parsePacketLoggerLine(nhdrAttLine({ gattHandle: 0x0057, value: [0x04, 0x03, 0x02, 0x21] })),
    { gattHandle: 0x0057, value: [0x04, 0x03, 0x02, 0x21] }
  );
});

test('nhdr parsing: ignores other devices, SEND direction, and malformed lines', () => {
  assert.equal(parsePacketLoggerLine(nhdrAttLine({ device: 'Xiaomi RC003', gattHandle: 0x2b, value: [0x41, 0x00] })), null);
  assert.equal(parsePacketLoggerLine(nhdrAttLine({ direction: 'SEND', gattHandle: 0x2b, value: [0x41, 0x00] })), null);
  assert.equal(parsePacketLoggerLine(''), null);
  assert.equal(parsePacketLoggerLine('not a packetlogger line'), null);
  assert.equal(parsePacketLoggerLine(null), null);
  // Missing RECV keyword or too few leading tokens.
  assert.equal(parsePacketLoggerLine('Sep 13 12:00:00 Chromecast Remote 0x000c RECV'), null);
});

test('nhdr parsing: tolerates punctuation after hex tokens', () => {
  const full = nhdrAttLine({ gattHandle: 0x2b, value: [0x41, 0x00] });
  const tokens = full.split(' ');
  const recv = tokens.indexOf('RECV');
  tokens[recv + 2] += ','; // trailing comma attached to a hex byte
  tokens.push(':'); // stray punctuation token is skipped
  assert.deepEqual(parsePacketLoggerLine(tokens.join(' ')), { gattHandle: 0x2b, value: [0x41, 0x00] });
});

test('ACL guards: wrong PB flag, CID, or ATT opcode are rejected', () => {
  const base = { gattHandle: 0x2b, value: [0x41, 0x00] };
  // PB flag = 0 (continuation fragment) must be rejected.
  const continuation = [0x0c, 0x00, 0x00, 0x00, 0x05, 0x00, 0x04, 0x00, 0x1b, 0x2b, 0x00, 0x41, 0x00];
  assert.equal(parseAclBytes(continuation), null);
  // Non-ATT CID.
  const line = nhdrAttLine(base);
  const tokens = line.split(' ');
  // Replace the ATT CID bytes (bytes 6/7 of the hex payload) with 0x0005.
  const hexIndex = tokens.indexOf('RECV') + 1 + 6;
  tokens[hexIndex] = '05';
  assert.equal(parsePacketLoggerLine(tokens.join(' ')), null);
  // ATT opcode 0x1a (handle-value indication, not notification).
  const opcodeIndex = tokens.indexOf('RECV') + 1 + 8;
  const opcode = tokens[opcodeIndex];
  tokens[opcodeIndex] = '1a';
  assert.equal(parsePacketLoggerLine(tokens.join(' ')), null);
  assert.match(opcode, /^1b$/);
  // Too short.
  assert.equal(parseAclBytes([0x0c, 0x20]), null);
  assert.equal(parseAclBytes([]), null);
  assert.equal(parseAclBytes(null), null);
});

// ---------------------------------------------------------------------------
// Button value decoding

test('button decoder: select/back down edges with dedupe and synthesized release', () => {
  const parser = new HciButtonValueParser();
  const feed = (value) => parser.feed({ gattHandle: HCI_BUTTON_GATT_HANDLE, value });

  assert.deepEqual(feed([0x41, 0x00]), [{ button: 'select', isDown: true }]);
  assert.deepEqual(feed([0x41, 0x00]), []); // held key: no duplicate edge
  assert.deepEqual(feed([0x24, 0x02]), [{ button: 'back', isDown: true }]);
  assert.deepEqual(feed([0x00, 0x00]), [
    { button: 'select', isDown: false },
    { button: 'back', isDown: false }
  ]);
  assert.deepEqual(feed([0x00, 0x00]), []); // release of released keys

  // Other physical keys (volume, d-pad…) and other handles are ignored.
  assert.deepEqual(feed([0x00, 0x01]), []);
  assert.deepEqual(feed([0x41]), []);
  assert.deepEqual(parser.feed({ gattHandle: 0x0054, value: [0x41, 0x00] }), []);

  // reset() drops held-key state: the next down edge fires again.
  parser.reset();
  assert.deepEqual(feed([0x41, 0x00]), [{ button: 'select', isDown: true }]);
});

// ---------------------------------------------------------------------------
// Source lifecycle against a fake daemon

test('hci source: startCapture handshake, button edges, request shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-src-'));
  const daemon = new FakeHciDaemon();
  await daemon.listen(join(dir, 'hci.sock'));
  const edges = [];
  const statuses = [];
  try {
    const source = new HciButtonSource({
      socketPath: join(dir, 'hci.sock'),
      onEdge: (edge) => edges.push(edge),
      onStatus: (info) => statuses.push(info),
      clock: fastClock()
    });
    source.start();
    await delay(200);
    assert.ok(statuses.some((info) => info.phase === 'capturing'));
    assert.equal(source.active, true);

    // The daemon sees a well-formed v2 startCapture request.
    const request = daemon.requests.find((item) => item.command === 'startCapture');
    assert.ok(request);
    assert.equal(request.protocol, 'vokie.appleTvRemote.hci');
    assert.equal(request.requiredVersion, '2');
    assert.equal(request.caller.pid, process.pid);
    assert.equal(typeof request.caller.uid, 'number');
    assert.equal(request.captureId, `chromecast-plugin-${process.pid}`);

    daemon.sendNhdr(nhdrSelectDown());
    daemon.sendNhdr(nhdrBackDown());
    daemon.sendNhdr(nhdrButtonUp());
    await delay(100);
    assert.deepEqual(edges, [
      { button: 'select', isDown: true },
      { button: 'back', isDown: true },
      { button: 'select', isDown: false },
      { button: 'back', isDown: false }
    ]);

    // Stop closes the socket; the daemon drops the capture with it.
    source.stop();
    assert.equal(source.active, false);
    await waitFor(() => daemon.capturing === false, 'daemon releases capture');
    assert.equal(daemon.sockets.length, 0);
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hci source: contention is retryable and not definitive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-src-'));
  const daemon = new FakeHciDaemon({ captureAllowed: false });
  await daemon.listen(join(dir, 'hci.sock'));
  const statuses = [];
  try {
    const source = new HciButtonSource({
      socketPath: join(dir, 'hci.sock'),
      onEdge: () => {},
      onStatus: (info) => statuses.push(info),
      clock: fastClock()
    });
    source.start();
    const retrying = await waitFor(() =>
      statuses.some((info) => info.phase === 'retrying' && info.definitive === false && /another capture/.test(info.error ?? ''))
    );
    assert.ok(retrying);
    // Contention retries until the capture becomes available, then captures.
    daemon.captureAllowed = true;
    await waitFor(() => statuses.some((info) => info.phase === 'capturing'));
    assert.ok(daemon.requests.filter((item) => item.command === 'startCapture').length >= 2);
    source.stop();
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hci source: hard failures are definitive', async () => {
  // Missing socket.
  const statuses = [];
  const source = new HciButtonSource({
    socketPath: '/nonexistent/test-hci.sock',
    onEdge: () => {},
    onStatus: (info) => statuses.push(info),
    clock: fastClock()
  });
  source.start();
  await waitFor(() => statuses.some((info) => info.phase === 'retrying' && info.definitive === true));
  source.stop();

  // PacketLogger missing (definitive captureUnavailable).
  const dir = await mkdtemp(join(tmpdir(), 'hci-src-'));
  const daemon = new FakeHciDaemon({
    captureAllowed: false,
    unavailableMessage: 'PacketLogger executable is missing'
  });
  await daemon.listen(join(dir, 'hci.sock'));
  const statuses2 = [];
  try {
    const source2 = new HciButtonSource({
      socketPath: join(dir, 'hci.sock'),
      onEdge: () => {},
      onStatus: (info) => statuses2.push(info),
      clock: fastClock()
    });
    source2.start();
    await waitFor(() => statuses2.some((info) => info.phase === 'retrying' && info.definitive === true));
    source2.stop();
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hci source: daemon drop mid-capture reconnects and recaptures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-src-'));
  const daemon = new FakeHciDaemon();
  await daemon.listen(join(dir, 'hci.sock'));
  const edges = [];
  const statuses = [];
  try {
    const source = new HciButtonSource({
      socketPath: join(dir, 'hci.sock'),
      onEdge: (edge) => edges.push(edge),
      onStatus: (info) => statuses.push(info),
      clock: fastClock()
    });
    source.start();
    await waitFor(() => statuses.some((info) => info.phase === 'capturing'));
    const before = daemon.requests.length;

    // The daemon restarts: every client socket is dropped.
    for (const socket of daemon.sockets.splice(0)) socket.destroy();
    await waitFor(() => statuses.some((info) => info.phase === 'retrying' && /中断|重连|关闭/.test(info.error ?? '')));
    await waitFor(() => statuses.filter((info) => info.phase === 'capturing').length >= 2);
    assert.ok(daemon.requests.length > before, 'reconnect sends a fresh startCapture');

    daemon.sendNhdr(nhdrSelectDown());
    await waitFor(() => edges.some((edge) => edge.button === 'select' && edge.isDown));
    source.stop();
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hci source: unexpected captureStopped re-requests the capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hci-src-'));
  const daemon = new FakeHciDaemon();
  await daemon.listen(join(dir, 'hci.sock'));
  const statuses = [];
  try {
    const source = new HciButtonSource({
      socketPath: join(dir, 'hci.sock'),
      onEdge: () => {},
      onStatus: (info) => statuses.push(info),
      clock: fastClock()
    });
    source.start();
    await waitFor(() => statuses.some((info) => info.phase === 'capturing'));
    daemon.stopCapture();
    await delay(100);
    // The daemon answered the follow-up startCapture with captureStarted.
    assert.equal(daemon.requests.filter((item) => item.command === 'startCapture').length >= 2, true);
    assert.ok(statuses.filter((info) => info.phase === 'capturing').length >= 2);
    source.stop();
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Poll until predicate() is true (bounded), like the e2e tests do. */
async function waitFor(predicate, label = 'condition', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
