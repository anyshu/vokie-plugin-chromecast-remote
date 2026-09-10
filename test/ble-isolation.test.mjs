import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BleTransport, uuidEquals } from '../worker/ble-transport.mjs';
import { isChromecastCandidate, pickChromecastCandidate } from '../worker/ble-device-selection.mjs';
import { ATVV, ManualClock, capabilitiesV10 } from './helpers.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const cast = { deviceId: 'opaque-cast-id', name: 'Chromecast Remote', serviceUuids: [] };
const xiaomi = { deviceId: 'xiaomi-id', name: 'RC003', serviceUuids: [ATVV.service] };

function fixture(subscribeHid = false) {
  const sent = [], status = [], ready = [], lost = [], notifications = [];
  const clock = new ManualClock();
  const transport = new BleTransport({ send: (m) => sent.push(m), clock, subscribeHid,
    onStatus: (m) => status.push(m), onReady: (m) => ready.push(m),
    onDeviceLost: (m) => lost.push(m), onNotification: (m) => notifications.push(m) });
  const last = (type) => sent.filter((m) => m.type === type).at(-1);
  const ack = async (type) => {
    const request = last(type);
    assert.ok(request, `missing ${type}`);
    transport.handleHostMessage({ type: 'ble_accepted', requestId: request.requestId });
    await flush();
    return request;
  };
  const scanResult = (devices, requestId = last('ble_scan').requestId) =>
    transport.handleHostMessage({ type: 'ble_scan_result', requestId, devices });
  return { transport, sent, status, ready, lost, notifications, clock, last, ack, scanResult };
}

async function negotiate(f) {
  await f.ack('ble_connect');
  for (const expected of [ATVV.control, ATVV.audio, ATVV.command]) {
    assert.ok(uuidEquals(f.last('ble_start_notify').characteristicUuid, expected));
    await f.ack('ble_start_notify');
  }
  await f.ack('ble_write');
  f.transport.handleHostMessage({ type: 'ble_notification', deviceId: cast.deviceId,
    characteristicUuid: ATVV.control, dataBase64: Buffer.from(capabilitiesV10()).toString('base64') });
}

test('ATVV, battery cache hits, anonymous devices and other models are not Chromecast identity', () => {
  for (const device of [xiaomi, { deviceId: 'battery', serviceUuids: ['180F'] },
    { deviceId: 'anonymous', serviceUuids: [ATVV.service] },
    { deviceId: 'wrong', name: 'Chromecast Speaker' }, { deviceId: ' ', name: cast.name }]) {
    assert.equal(isChromecastCandidate(device), false);
  }
  assert.ok(isChromecastCandidate({ ...cast, name: ' Chromecast Voice Remote ' }));
  assert.equal(pickChromecastCandidate([xiaomi, cast], new Map(), 0), cast);
  const failures = new Map([[cast.deviceId, 10000]]);
  assert.equal(pickChromecastCandidate([cast], failures, 9999), null);
  assert.equal(pickChromecastCandidate([cast], failures, 10000), cast);
});

test('mixed BLE scan connects only Chromecast; duplicate/old results cannot start another connection', () => {
  const f = fixture();
  f.transport.start();
  f.scanResult([xiaomi, cast], 'stale-scan');
  assert.equal(f.last('ble_connect'), undefined);
  f.scanResult([xiaomi, cast]);
  assert.equal(f.last('ble_connect').deviceId, cast.deviceId);
  f.scanResult([{ ...cast, deviceId: 'another-cast' }]);
  assert.equal(f.sent.filter((m) => m.type === 'ble_connect').length, 1);
  assert.equal(f.transport.deviceId, cast.deviceId); // reserved before ack
  f.transport.handleHostMessage({ type: 'ble_rejected', requestId: 'old-error', reason: 'permission_denied' });
  assert.equal(f.transport.started, true);
  f.transport.stop();
});

test('scan containing only Xiaomi never connects it as an ATVV fallback', () => {
  const f = fixture();
  f.transport.start();
  f.scanResult([xiaomi]);
  assert.equal(f.last('ble_connect'), undefined);
  assert.equal(f.status.at(-1).phase, 'backoff');
  f.transport.stop();
});

for (const eventFirst of [true, false]) {
  test(`stop/restart during connect waits for disconnect ack (eventFirst=${eventFirst})`, async () => {
    const f = fixture();
    f.transport.start(); f.scanResult([cast]);
    const oldConnect = f.last('ble_connect');
    f.transport.stop(); f.transport.start();
    assert.equal(f.sent.filter((m) => m.type === 'ble_scan').length, 1);
    const event = { type: 'ble_disconnected', deviceId: cast.deviceId, reason: 'requested' };
    if (eventFirst) f.transport.handleHostMessage(event);
    f.transport.handleHostMessage({ type: 'ble_accepted', requestId: oldConnect.requestId });
    await flush();
    assert.equal(f.last('ble_start_notify'), undefined);
    assert.equal(f.sent.filter((m) => m.type === 'ble_scan').length, 1);
    await f.ack('ble_disconnect');
    if (!eventFirst) f.transport.handleHostMessage(event);
    assert.equal(f.sent.filter((m) => m.type === 'ble_scan').length, 2);
    f.transport.stop();
  });
}

test('connect timeout releases ownership before retry and does not blacklist the remote forever', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([cast]);
  f.clock.advance(5000); await flush();
  assert.equal(f.last('ble_disconnect').deviceId, cast.deviceId);
  assert.equal(f.status.some((m) => m.phase === 'backoff'), false);
  await f.ack('ble_disconnect');
  f.clock.advance(1000); f.scanResult([cast]);
  assert.equal(f.sent.filter((m) => m.type === 'ble_connect').length, 1);
  f.clock.advance(9000); // candidate cooldown expires at t=15000
  f.scanResult([cast]);
  assert.equal(f.sent.filter((m) => m.type === 'ble_connect').length, 2);
  f.transport.stop();
});

test('disconnect during GATT setup invalidates late subscription callbacks and capabilities', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([cast]);
  await f.ack('ble_connect');
  const oldNotify = f.last('ble_start_notify');
  f.transport.handleHostMessage({ type: 'ble_disconnected', deviceId: cast.deviceId, reason: 'link_lost' });
  f.transport.handleHostMessage({ type: 'ble_accepted', requestId: oldNotify.requestId });
  await flush();
  assert.deepEqual(f.lost, ['link_lost']);
  assert.equal(f.sent.filter((m) => m.type === 'ble_start_notify').length, 1);
  assert.equal(f.last('ble_write'), undefined);
  assert.equal(f.clock.pendingCount, 1); // only reconnect backoff remains
  f.transport.stop();
});

test('name match with missing required ATVV service releases the device without declaring ready', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([cast]);
  await f.ack('ble_connect');
  f.transport.handleHostMessage({ type: 'ble_rejected', requestId: f.last('ble_start_notify').requestId,
    reason: 'not_found', message: 'characteristic not found' });
  await flush();
  assert.equal(f.ready.length, 0);
  assert.equal(f.last('ble_disconnect').deviceId, cast.deviceId);
  await f.ack('ble_disconnect');
  assert.equal(f.status.at(-1).phase, 'backoff');
  f.transport.stop();
});

test('native button mode uses only ATVV BLE; unrelated notifications and duplicate caps are ignored', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([xiaomi, cast]);
  await negotiate(f);
  assert.equal(f.ready.length, 1);
  assert.equal(f.ready[0].hidSubscribed, false);
  const notify = (deviceId, characteristicUuid, data = [1, 7], receivedAtMs) =>
    f.transport.handleHostMessage({ type: 'ble_notification', deviceId, characteristicUuid,
      dataBase64: Buffer.from(data).toString('base64'), receivedAtMs });
  notify(xiaomi.deviceId, ATVV.audio);
  notify(cast.deviceId, '2A4D'); // unsolicited, no subscription in this mode
  notify(cast.deviceId, '2A19');
  assert.equal(f.notifications.length, 0);
  notify(cast.deviceId, ATVV.audio, [0x77], 123.5);
  assert.equal(f.notifications.at(-1).receivedAtMs, 123.5);
  notify(cast.deviceId, ATVV.audio, [0x77]);
  assert.equal(f.notifications.at(-1).receivedAtMs, f.clock.now());
  notify(cast.deviceId, ATVV.control, capabilitiesV10());
  assert.equal(f.ready.length, 1);
  f.transport.stop();
});

test('disconnect cleanup timeout stops retries while native ownership is uncertain', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([cast]);
  f.transport.handleHostMessage({ type: 'ble_rejected', requestId: f.last('ble_connect').requestId, reason: 'busy' });
  await flush();
  f.clock.advance(5000); await flush();
  assert.equal(f.transport.started, false);
  assert.match(f.status.at(-1).message, /释放失败/);
  f.clock.advance(60000); await flush();
  assert.equal(f.sent.filter((m) => m.type === 'ble_scan').length, 1);
});

const NOTIFY_UNSUPPORTED = 'The request is not supported. (notify_failed)';

function rejectNotify(f, message = NOTIFY_UNSUPPORTED, reason = 'failed') {
  f.transport.handleHostMessage({ type: 'ble_rejected', requestId: f.last('ble_start_notify').requestId, reason, message });
}

function sendCapabilities(f) {
  f.transport.handleHostMessage({ type: 'ble_notification', deviceId: cast.deviceId,
    characteristicUuid: ATVV.control, dataBase64: Buffer.from(capabilitiesV10()).toString('base64') });
}

test('unsupported optional command notification preserves ATVV control/audio and completes negotiation', async () => {
  const f = fixture(); f.transport.start(); f.scanResult([cast]);
  await f.ack('ble_connect');
  await f.ack('ble_start_notify'); // required control
  await f.ack('ble_start_notify'); // required audio
  assert.ok(uuidEquals(f.last('ble_start_notify').characteristicUuid, ATVV.command));
  rejectNotify(f); await flush();
  assert.equal(f.transport.started, true);
  assert.equal(f.last('ble_disconnect'), undefined);
  assert.equal(f.status.some((m) => m.phase === 'error'), false);
  assert.deepEqual(f.status.find((m) => m.requestFailure).requestFailure, {
    operation: 'ble_start_notify', characteristicUuid: ATVV.command, reason: 'failed', message: NOTIFY_UNSUPPORTED
  });
  await f.ack('ble_write'); sendCapabilities(f);
  assert.equal(f.ready.length, 1);
  f.transport.handleHostMessage({ type: 'ble_notification', deviceId: cast.deviceId,
    characteristicUuid: ATVV.audio, dataBase64: Buffer.from([0x77]).toString('base64') });
  assert.deepEqual([...f.notifications.at(-1).data], [0x77]);
  f.transport.stop();
});

test('unsupported GATT HID notifies degrade buttons only and still negotiate voice', async () => {
  const f = fixture(true); f.transport.start(); f.scanResult([cast]);
  await f.ack('ble_connect'); await f.ack('ble_start_notify'); await f.ack('ble_start_notify');
  for (const uuid of ['2A4D', '00002a4d-0000-1000-8000-00805f9b34fb']) {
    assert.equal(f.last('ble_start_notify').characteristicUuid, uuid);
    rejectNotify(f); await flush();
  }
  assert.equal(f.transport.started, true);
  assert.ok(f.status.some((m) => m.hidAvailable === false));
  await f.ack('ble_start_notify'); await f.ack('ble_write'); sendCapabilities(f);
  assert.equal(f.ready.length, 1);
  assert.equal(f.ready[0].hidSubscribed, false);
  f.transport.stop();
});

for (const characteristic of [ATVV.control, ATVV.audio]) {
  test(`unsupported required notification ${characteristic} releases and retries with its exact failure`, async () => {
    const f = fixture(); f.transport.start(); f.scanResult([cast]);
    await f.ack('ble_connect');
    if (characteristic === ATVV.audio) await f.ack('ble_start_notify');
    rejectNotify(f); await flush();
    assert.equal(f.transport.started, true);
    assert.equal(f.ready.length, 0);
    assert.equal(f.last('ble_disconnect').deviceId, cast.deviceId);
    assert.ok(f.lost.at(-1).includes(characteristic));
    assert.ok(f.lost.at(-1).includes(NOTIFY_UNSUPPORTED));
    await f.ack('ble_disconnect');
    assert.equal(f.status.at(-1).phase, 'backoff');
    f.transport.stop();
  });
}

for (const [reason, message] of [
  ['failed', 'BLE adapter backend unavailable on this platform'],
  ['permission_denied', 'Bluetooth permission denied'],
  ['invalid_request', 'Unsupported adapter API version']
]) {
  test(`optional notify does not swallow a real adapter failure: ${reason}`, async () => {
    const f = fixture(); f.transport.start(); f.scanResult([cast]);
    await f.ack('ble_connect'); await f.ack('ble_start_notify'); await f.ack('ble_start_notify');
    rejectNotify(f, message, reason); await flush();
    assert.equal(f.transport.started, false);
    assert.equal(f.ready.length, 0);
    assert.equal(f.last('ble_disconnect').deviceId, cast.deviceId);
    assert.ok(f.status.find((m) => m.phase === 'error').message.includes(ATVV.command));
    await f.ack('ble_disconnect');
    f.clock.advance(60000); await flush();
    assert.equal(f.sent.filter((m) => m.type === 'ble_scan').length, 1);
  });
}
