import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonReport, matchesHciSource, remoteProfile } from '../worker/remote-profile.mjs';
import { HciIdentity, attPacket, parseTraceLine } from '../worker/hci-identity.mjs';
import { HciButtonValueParser, parseAclBytes } from '../worker/hci-button-source.mjs';
import { HidButtonParser } from '../worker/hid-reports.mjs';
import { nhdrAttLine } from './helpers.mjs';

export function acl(value, handle = 12, boundary = 2) {
  return [handle & 255, handle >> 8 | boundary << 4, value.length + 4, 0, value.length, 0, 4, 0, ...value];
}
const serial = '1234567890';
const request = acl([0x0a, 0x10, 0]);
const response = acl([0x0b, ...Buffer.from(serial)]);

// Captured A0 / 26.2 values from the built-in implementation's regression.
test('A0 captures map only complete 8-byte reports on handle 0x29; legacy remains isolated', () => {
  assert.equal(remoteProfile(' A0 '), 'a0');
  assert.equal(remoteProfile('hid_mouse'), 'legacy');
  const parser = new HciButtonValueParser();
  parser.profile = 'a0';
  const feed = value => parser.feed({ gattHandle: 0x29, value });
  const select = [7, 0, 0, 0, 0, 0, 0, 0], back = [11, 0, 0, 0, 0, 0, 0, 0], up = Array(8).fill(0);
  assert.deepEqual(feed(select), [{ button: 'select', isDown: true }]);
  assert.deepEqual(feed(select), []);
  assert.deepEqual(feed(up), [{ button: 'select', isDown: false }]);
  assert.deepEqual(feed(back), [{ button: 'back', isDown: true }]);
  assert.deepEqual(feed(up), [{ button: 'back', isDown: false }]);
  for (const value of [[7], [7, 0], select.slice(1), [7, 1, 0, 0, 0, 0, 0, 0], [8, 0, 0, 0, 0, 0, 0, 0], [0x41, 0]]) {
    assert.deepEqual(feed(value), []);
  }
  assert.equal(buttonReport('legacy', { gattHandle: 0x2b, value: select }), null);
  assert.equal(buttonReport('a0', { gattHandle: 0x2b, value: select }), null);
  assert.equal(buttonReport('legacy', { gattHandle: 0x2b, value: [0x41, 0] }), 'select');
  const hid = new HidButtonParser();
  hid.profile = 'a0';
  assert.deepEqual(hid.feed(Uint8Array.from(select)), [{ button: 'select', isDown: true }]);
  assert.deepEqual(hid.feed(Uint8Array.from([1, ...up])), [{ button: 'select', isDown: false }]);
  assert.deepEqual(hid.feed(Uint8Array.of(1, 7)), []);
});

test('HCI source address matching rejects zero and unrelated addresses', () => {
  assert.ok(matchesHciSource('47:54:51:45:A5:A8', '47-54-51-45-a5-a8'));
  assert.ok(matchesHciSource('Chromecast Remote', null));
  assert.equal(matchesHciSource('00:00:00:00:00:00', '00-00-00-00-00-00'), false);
  assert.equal(matchesHciSource('47:54:51:45:A5:A9', '47-54-51-45-a5-a8'), false);
});

test('identity requires both observed serial read and native confirmation, in either callback order', () => {
  for (const confirmFirst of [false, true]) {
    const identity = new HciIdentity();
    identity.begin(serial, 0);
    if (confirmFirst) identity.confirm(Buffer.from(serial), 1);
    identity.observe(response, true, 1); // no preceding read
    assert.equal(identity.connectionHandle, null);
    identity.observe(request, false, 2);
    identity.observe(response, true, 3);
    if (!confirmFirst) {
      assert.equal(identity.connectionHandle, null);
      identity.confirm(Buffer.from(serial), 4);
    }
    assert.equal(identity.connectionHandle, 12);
    assert.ok(identity.accepts(acl([0x1b, 0x29, 0, 7, 0, 0, 0, 0, 0, 0, 0])));
    assert.equal(identity.accepts(acl([0x1b, 0x29, 0, 7], 13)), false);
    identity.observe([5, 4, 0, 12, 0, 0x13], true, 10000);
    assert.equal(identity.connectionHandle, null);
  }
});

test('identity rejects stale, malformed, ambiguous and wrong-serial evidence', () => {
  const identity = new HciIdentity();
  identity.begin(serial, 0);
  identity.observe(request, false, 1);
  identity.observe(response, true, 3001);
  identity.confirm(Buffer.from(serial), 3002);
  assert.equal(identity.connectionHandle, null);
  identity.begin(serial, 4000);
  identity.observe(request, false, 4001);
  identity.observe(response, true, 4002);
  identity.confirm(Buffer.from('wrong-serial'), 4003);
  assert.equal(identity.connectionHandle, null);
  identity.confirm(Buffer.from(serial), 4004);
  assert.equal(identity.connectionHandle, 12);
  identity.observe(acl([0x0a, 0x10, 0], 13), false, 4005);
  identity.observe(acl([0x0b, ...Buffer.from(serial)], 13), true, 4006);
  assert.equal(identity.connectionHandle, null);
  identity.reset();
  assert.equal(identity.accepts(response), false);
  assert.equal(attPacket(response.slice(0, -1)), null);
  assert.equal(attPacket([...response, 0]), null);
  assert.ok(attPacket(acl([0x0a, 0x10, 0], 12, 0))); // SEND PB=0
  const line = nhdrAttLine({ gattHandle: 0x29, value: [7, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(parseTraceLine(line + ' 0G'), null);
  assert.equal(parseAclBytes(parseTraceLine(line).bytes.slice(0, -1)), null);
});
