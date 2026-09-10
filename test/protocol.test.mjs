// Unit tests for the protocol modules: ATVV codec, PCM helpers, HID parser,
// host session bookkeeping, the BLE transport, and the gesture state machine.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATVV_CODEC_ADPCM_16K,
  ATVV_CODEC_ADPCM_8K,
  ATVV_REASON_PHYSICAL_START,
  ATVV_REASON_PHYSICAL_STOP,
  AtvvAudioDecoder,
  GET_CAPABILITIES_COMMAND,
  keepAliveCommand,
  micCloseCommand,
  micOpenCommand,
  parseCapabilities,
  parseControlEvent,
  selectCodec
} from '../worker/atvv-protocol.mjs';
import { BoundedPcmBuffer, encodeAudioFrame, pcmToBytes, upsampleX2 } from '../worker/pcm.mjs';
import { HidButtonParser } from '../worker/hid-reports.mjs';
import { HostSession } from '../worker/host-session.mjs';
import { DeviceSession, DEFAULT_CONFIG } from '../worker/device-session.mjs';
import { BleTransport, HID_REPORT_UUID, uuidEquals } from '../worker/ble-transport.mjs';
import { HidHelperSource } from '../worker/hid-helper-source.mjs';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATVV,
  ManualClock,
  audioStartHost,
  audioStartPhysical,
  audioStopGeneric,
  audioStopPhysical,
  audioSync,
  capabilitiesV04,
  capabilitiesV10,
  delay,
  micOpenError,
  v04Frame
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// ATVV protocol.

test('capabilities parsing for v1.0 and v0.4', () => {
  const v10 = parseCapabilities(capabilitiesV10({ codecs: 0x03, frameSize: 161 }));
  assert.equal(v10.version, '1.0');
  assert.equal(v10.codecs, 0x03);
  assert.equal(v10.frameSize, 161);
  const v04 = parseCapabilities(capabilitiesV04({ codecs: 0x02, frameSize: 120 }));
  assert.equal(v04.version, '0.4');
  assert.equal(v04.codecs, 0x02);
  assert.equal(v04.frameSize, 120);
  assert.equal(parseCapabilities(Uint8Array.of(0x0b, 0x00, 0x05)), null);
  assert.equal(selectCodec({ codecs: 0x02 }), ATVV_CODEC_ADPCM_16K);
  assert.equal(selectCodec({ codecs: 0x01 }), ATVV_CODEC_ADPCM_8K);
  assert.equal(selectCodec({ codecs: 0x00 }), null);
});

test('command encoders per version', () => {
  assert.deepEqual([...GET_CAPABILITIES_COMMAND], [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]);
  assert.deepEqual([...micOpenCommand('0.4', ATVV_CODEC_ADPCM_16K)], [0x0c, 0x00, 0x02]);
  assert.deepEqual([...micOpenCommand('1.0', ATVV_CODEC_ADPCM_16K)], [0x0c, 0x00]);
  assert.deepEqual([...micCloseCommand('0.4', 7)], [0x0d]);
  assert.deepEqual([...micCloseCommand('1.0', 7)], [0x0d, 0x07]);
  assert.deepEqual([...keepAliveCommand('1.0', 7, 2)], [0x0e, 0x07]);
  assert.deepEqual([...keepAliveCommand('0.4', 7, ATVV_CODEC_ADPCM_16K)], [0x0c, 0x00, 0x02]);
});

test('control event parsing', () => {
  const session = { version: '1.0', codec: 0x02 };
  assert.deepEqual(
    parseControlEvent(audioStartPhysical({ streamId: 7 }), session),
    { type: 'audio_start', reason: 0x03, codec: 0x02, streamId: 7 }
  );
  assert.deepEqual(parseControlEvent(audioStopPhysical(), session), { type: 'audio_stop', reason: ATVV_REASON_PHYSICAL_STOP });
  assert.deepEqual(
    parseControlEvent(audioSync({ sequence: 9, predictor: -11, stepIndex: 3 }), session),
    { type: 'audio_sync', codec: 0x02, sequence: 9, predictor: -11, stepIndex: 3 }
  );
  assert.deepEqual(parseControlEvent(micOpenError(0x0102), session), { type: 'mic_open_error', code: 0x0102 });
  assert.equal(parseControlEvent(Uint8Array.of(0x08), session).type, 'start_search');
  // v0.4 audio_start falls back to the negotiated codec with streamId 0.
  assert.deepEqual(
    parseControlEvent(Uint8Array.of(0x04, 0x00), { version: '0.4', codec: 0x01 }),
    { type: 'audio_start', reason: 0x00, codec: 0x01, streamId: 0 }
  );
  assert.equal(parseControlEvent(Uint8Array.of(0x7f), session).type, 'unknown');
});

test('ADPCM decoder matches hand-traced IMA reference values', () => {
  const decoder = new AtvvAudioDecoder();
  // From reset(0,0), nibble 7 -> +11 (step 7, index 8); nibble 7 -> +30 (step
  // STEP_TABLE[8]=16, index 16); nibble 0 -> +4 (step 34>>3, index 15);
  // nibble 0 -> +3 (step 31>>3, index 14).
  decoder.reset(0, 0);
  assert.deepEqual([...decoder.decode(Uint8Array.of(0x77, 0x00), { version: '1.0' }).samples], [11, 41, 45, 48]);
  // Predictor is included as the first sample of a v0.4 frame.
  const frame = decoder.decode(v04Frame({ predictor: 11, stepIndex: 0, nibbles: Uint8Array.of(0x77, 0x00) }), {
    version: '0.4',
    frameSize: 8
  });
  assert.deepEqual([...frame.samples], [11, 22, 52, 56, 59]);
  assert.equal(frame.sequence, 0);
  // Silent stream stays silent.
  const quiet = new AtvvAudioDecoder();
  quiet.reset(0, 0);
  assert.deepEqual([...quiet.decode(Uint8Array.of(0x00, 0x00, 0x00), { version: '1.0' }).samples], [0, 0, 0, 0, 0, 0]);
  // v1.0 sequence numbers increment locally.
  const seq = new AtvvAudioDecoder();
  seq.reset(0, 0);
  assert.equal(seq.decode(Uint8Array.of(0x00), { version: '1.0' }).sequence, 0);
  assert.equal(seq.decode(Uint8Array.of(0x00), { version: '1.0' }).sequence, 1);
  // Wrong v0.4 frame size is rejected.
  assert.equal(decoder.decode(Uint8Array.of(1, 2, 3, 4, 5, 6, 7), { version: '0.4', frameSize: 9 }), null);
});

test('decoder sync-before-start survives beginStream', () => {
  const synced = new AtvvAudioDecoder();
  synced.applySync({ predictor: -100, stepIndex: 40 });
  synced.beginStream(); // pending sync must not be erased
  const reference = new AtvvAudioDecoder();
  reference.reset(-100, 40);
  assert.deepEqual(
    [...synced.decode(Uint8Array.of(0x77), { version: '1.0' }).samples],
    [...reference.decode(Uint8Array.of(0x77), { version: '1.0' }).samples]
  );
  // Without a sync, beginStream resets stale state.
  const stale = new AtvvAudioDecoder();
  stale.reset(1234, 88);
  stale.beginStream();
  const fresh = new AtvvAudioDecoder();
  fresh.reset(0, 0);
  assert.deepEqual(
    [...stale.decode(Uint8Array.of(0x77), { version: '1.0' }).samples],
    [...fresh.decode(Uint8Array.of(0x77), { version: '1.0' }).samples]
  );
});

// ---------------------------------------------------------------------------
// PCM helpers.

test('upsampleX2 doubles length with interpolated midpoint', () => {
  const out = upsampleX2(Int16Array.of(0, 100, 200));
  assert.deepEqual([...out], [0, 50, 100, 150, 200]);
});

test('pcmToBytes is little-endian', () => {
  assert.deepEqual([...pcmToBytes(Int16Array.of(1, -1))], [0x01, 0x00, 0xff, 0xff]);
});

test('audio frame encoding', () => {
  const frame = encodeAudioFrame('req-1', 3, Buffer.from([0x01, 0x00]));
  const headerLength = frame.readUInt32BE(0);
  const header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  assert.equal(header.type, 'audio');
  assert.equal(header.requestId, 'req-1');
  assert.equal(header.sequence, 3);
  assert.equal(header.sampleRate, 16000);
  assert.equal(header.channels, 1);
  assert.equal(header.format, 'pcm_s16le');
  assert.deepEqual([...frame.subarray(4 + headerLength)], [0x01, 0x00]);
  assert.throws(() => encodeAudioFrame('req-1', 0, Buffer.alloc(0)));
  assert.throws(() => encodeAudioFrame('req-1', 0, Buffer.from([0x01])));
});

test('bounded buffer keeps newest audio under the millisecond cap', () => {
  const buffer = new BoundedPcmBuffer(6); // 6 ms at 16 kHz = 96 samples
  buffer.push(Int16Array.from({ length: 100 }, (_, i) => i));
  buffer.push(Int16Array.from({ length: 100 }, (_, i) => 1000 + i));
  const drained = buffer.drain();
  assert.equal(drained.length, 96); // capped
  assert.equal(drained[0], 1004); // oldest dropped, newest retained
  assert.equal(drained[95], 1099);
  assert.equal(buffer.length, 0);
});

// ---------------------------------------------------------------------------
// HID button parser.

test('HID parser edges with de-duplication', () => {
  const parser = new HidButtonParser();
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x07)), [{ button: 'select', isDown: true }]);
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x07)), []); // noisy repeat
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x0b)), [
    { button: 'select', isDown: false },
    { button: 'back', isDown: true }
  ]);
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x00)), [{ button: 'back', isDown: false }]);
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x00)), []); // release without press
  assert.deepEqual(parser.feed(Uint8Array.of(0x02, 0x07)), []); // other report id
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x99)), [{ button: null, isDown: true }]); // unknown usage
  assert.deepEqual(parser.feed(Uint8Array.of(0x01, 0x00)), [{ button: null, isDown: false }]);
});

// ---------------------------------------------------------------------------
// Host session.

test('host session buffers before acceptance and flushes in order', () => {
  const json = [];
  const binary = [];
  const session = new HostSession({ sendJson: (m) => json.push(m), sendBinary: (b) => binary.push(b) });
  const requestId = session.begin('ptt');
  assert.equal(json[0].type, 'session_start');
  assert.equal(json[0].mode, 'ptt');
  assert.deepEqual(json[0].options.audioSource, { type: 'stream', format: 'pcm_s16le', sampleRate: 16000, channels: 1 });

  session.feed(Int16Array.of(1, 2, 3)); // pre-acceptance
  assert.equal(binary.length, 0);
  assert.equal(session.accepted(requestId), true);
  assert.equal(binary.length, 1);
  const first = parseFrame(binary[0]);
  assert.equal(first.header.requestId, requestId);
  assert.equal(first.header.sequence, 0);
  assert.deepEqual([...first.pcm], [...pcmToBytes(Int16Array.of(1, 2, 3))]);

  session.feed(Int16Array.from({ length: 2000 }, (_, i) => i % 100)); // 2000 samples -> 2 frames of 1600
  assert.equal(binary.length, 3);
  assert.equal(parseFrame(binary[1]).header.sequence, 1);
  assert.equal(parseFrame(binary[2]).header.sequence, 2);
  assert.equal(parseFrame(binary[2]).pcm.length, 800);

  // Another request's acceptance is ignored.
  assert.equal(session.accepted('other'), false);
  assert.equal(session.end('device'), requestId);
  assert.equal(json.at(-1).type, 'session_stop');
  assert.equal(json.at(-1).reason, 'device');
  assert.equal(session.active, false);
  session.feed(Int16Array.of(9));
  assert.equal(binary.length, 3); // dropped after end
});

test('host session cancel sends session_cancel', () => {
  const json = [];
  const session = new HostSession({ sendJson: (m) => json.push(m), sendBinary: () => {} });
  session.begin('handsfree-ptt');
  session.end('device_lost', { cancel: true });
  assert.equal(json.at(-1).type, 'session_cancel');
  assert.equal(json.at(-1).reason, 'device_lost');
});

test('host session rejected clears state', () => {
  const json = [];
  const session = new HostSession({ sendJson: (m) => json.push(m), sendBinary: () => {} });
  const requestId = session.begin('ptt', Int16Array.of(5, 6));
  assert.equal(session.rejected(requestId), true);
  assert.equal(session.active, false);
  session.feed(Int16Array.of(7));
  assert.equal(session.accepted(requestId), false);
});

function parseFrame(buffer) {
  const headerLength = buffer.readUInt32BE(0);
  return {
    header: JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8')),
    pcm: buffer.subarray(4 + headerLength)
  };
}

// ---------------------------------------------------------------------------
// Device session gesture machine (manual clock).

function createDeviceSession(clock, overrides = {}) {
  const calls = { startSession: [], stopSession: [], commands: [], writes: [], audio: [], status: [] };
  const session = new DeviceSession({
    clock,
    config: { ...DEFAULT_CONFIG, ...(overrides.config ?? {}) },
    hooks: {
      startSession: (mode, kind, initial) => calls.startSession.push({ mode, kind, initial: [...initial] }),
      stopSession: (reason, options) => calls.stopSession.push({ reason, ...(options ?? {}) }),
      sendCommand: (command) => calls.commands.push(command),
      writeDevice: (bytes) => calls.writes.push([...bytes]),
      onAudio: (samples) => calls.audio.push([...samples]),
      onStatus: (info) => calls.status.push(info)
    }
  });
  session.deviceReady({
    name: 'Chromecast Remote',
    atvv: { version: '1.0', codecs: 0x02, codec: 0x02, frameSize: 161, sampleRate: 16000 },
    hidSubscribed: true
  });
  return { session, calls };
}

test('tap mode: short tap opens a handsfree session and a persistent mic stream', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });

  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 7 }), session.atvv));
  assert.equal(session.phase, 'pressing');
  session.audioData(Uint8Array.of(0x77, 0x00)); // [11, 41, 45, 48] buffered
  clock.advance(300); // below the 550 ms threshold
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));

  // Tap: session starts with the buffered tap audio, MIC_OPEN is sent.
  assert.equal(calls.startSession.length, 1);
  assert.equal(calls.startSession[0].mode, 'handsfree-ptt');
  assert.equal(calls.startSession[0].kind, 'tap');
  assert.deepEqual(calls.startSession[0].initial, [11, 41, 45, 48]);
  assert.deepEqual(calls.writes.at(-1), [0x0c, 0x00]);
  assert.equal(session.phase, 'persistent');

  // Host stream confirmation: audio now feeds the session live.
  session.controlEvent(parseControlEvent(audioStartHost({ streamId: 8 }), session.atvv));
  session.audioData(Uint8Array.of(0x77, 0x00));
  assert.deepEqual(calls.audio.at(-1), [11, 41, 45, 48]);
  clock.advance(4000); // keep-alive while streaming
  assert.deepEqual(calls.writes.at(-1), [0x0e, 0x08]);

  // Second tap: press+release closes the session and the mic.
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 9 }), session.atvv));
  assert.equal(session.phase, 'persistent'); // no new session
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.deepEqual(calls.stopSession, [{ reason: 'device' }]);
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x09]);
  assert.equal(session.phase, 'idle');
  assert.equal(clock.pendingCount, 0);
});

test('hold mode: any press starts a ptt session immediately, release stops it (no threshold)', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock); // default voiceMode: hold

  // The session starts at key-down, before any audio arrives.
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 3 }), session.atvv));
  assert.equal(session.phase, 'holding');
  assert.deepEqual(calls.startSession, [{ mode: 'ptt', kind: 'hold', initial: [] }]);
  // Audio during the acceptance round-trip forwards to the host session.
  session.audioData(Uint8Array.of(0x77));
  assert.deepEqual(calls.audio, [[11, 41]]);
  session.audioData(Uint8Array.of(0x00));
  assert.deepEqual(calls.audio.at(-1), [45, 48]);

  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.deepEqual(calls.stopSession, [{ reason: 'device' }]);
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x03]);
  assert.equal(session.phase, 'idle');
});

test('hold mode: a quick tap is just a very short ptt session', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock);
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 7 }), session.atvv));
  session.audioData(Uint8Array.of(0x77, 0x00));
  clock.advance(150); // quick tap — no threshold filtering
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.deepEqual(calls.startSession, [{ mode: 'ptt', kind: 'hold', initial: [] }]);
  assert.deepEqual(calls.stopSession, [{ reason: 'device' }]);
  assert.deepEqual(calls.audio, [[11, 41, 45, 48]]);
  assert.equal(session.phase, 'idle');
});

test('tap mode: any press duration toggles recording on (no threshold)', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });
  // A quick press (549 ms) and a slow press (900 ms) both toggle on.
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 3 }), session.atvv));
  assert.deepEqual(calls.startSession, []); // tap mode starts at release, not press
  clock.advance(549);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.equal(calls.startSession.length, 1);
  assert.equal(calls.startSession[0].kind, 'tap');
  assert.equal(session.phase, 'persistent');

  // Close it, then a slow press opens again.
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 4 }), session.atvv));
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv)); // toggle off
  assert.deepEqual(calls.stopSession, [{ reason: 'device' }]);
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 5 }), session.atvv));
  clock.advance(900); // way beyond any hold threshold — still a toggle press
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.equal(calls.startSession.length, 2);
  assert.equal(calls.startSession[1].kind, 'tap');
});

test('tap mode: mic open errors are retry-paced and give up with cancel', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });

  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 5 }), session.atvv));
  clock.advance(200);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv)); // tap
  assert.equal(session.phase, 'persistent');

  // An immediate error response must NOT trigger an immediate retry; the
  // confirm timer paces attempts ~1 s apart.
  session.controlEvent(parseControlEvent(micOpenError(1), session.atvv));
  assert.equal(calls.writes.filter((w) => w[0] === 0x0c).length, 1);
  clock.advance(500); // still inside the confirm window
  session.controlEvent(parseControlEvent(micOpenError(2), session.atvv));
  assert.equal(calls.writes.filter((w) => w[0] === 0x0c).length, 1);
  clock.advance(500); // confirm timer fires -> attempt 2
  assert.equal(calls.writes.filter((w) => w[0] === 0x0c).length, 2);
  clock.advance(1000); // attempt 3
  assert.equal(calls.writes.filter((w) => w[0] === 0x0c).length, 3);
  clock.advance(1000); // exhausted -> cancel the session
  assert.deepEqual(calls.stopSession, [{ reason: 'mic_open_failed', cancel: true }]);
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x05]);
  assert.equal(session.phase, 'idle');
});

test('tap mode: a stray duplicate release after conversion does not kill the session', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 7 }), session.atvv));
  clock.advance(300);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv)); // tap: convert
  session.controlEvent(parseControlEvent(audioStartHost({ streamId: 8 }), session.atvv)); // confirmed

  // BLE-retransmitted duplicate of the same release (reason 0x02, no gesture):
  // must be ignored, the persistent session keeps running.
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.equal(session.phase, 'persistent');
  assert.deepEqual(calls.stopSession, []);
  session.audioData(Uint8Array.of(0x77));
  assert.deepEqual(calls.audio.at(-1), [11, 41]);

  // A non-physical stop (real stream end) still closes the session.
  session.controlEvent(parseControlEvent(audioStopGeneric(0x00), session.atvv));
  assert.deepEqual(calls.stopSession, [{ reason: 'device' }]);
  assert.equal(session.phase, 'idle');
});

test('session rejection during hold keeps the gesture until release', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock);
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 3 }), session.atvv));
  assert.equal(session.phase, 'holding'); // session started at key-down
  session.sessionRejected('busy');
  // The device session keeps forwarding stream audio; the (already rejected)
  // host session is the layer that drops it.
  session.audioData(Uint8Array.of(0x00));
  assert.deepEqual(calls.audio, [[0, 0]]);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.deepEqual(calls.stopSession, []); // session already dead at the Host
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x03]);
  assert.equal(session.phase, 'idle');
});

test('tap mode: session rejection during conversion aborts and closes the mic', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 5 }), session.atvv));
  clock.advance(200);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  session.sessionRejected('busy');
  assert.equal(session.phase, 'idle');
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x05]);
  assert.deepEqual(calls.stopSession, []);
});

test('stale host stream while idle is closed idempotently', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock);
  session.controlEvent(parseControlEvent(audioStartHost({ streamId: 4 }), session.atvv));
  assert.equal(session.phase, 'idle');
  assert.deepEqual(calls.writes, [[0x0d, 0x04]]);
  assert.deepEqual(calls.startSession, []);
  // The stream stays device-active until its AUDIO_STOP; the session layer
  // (no session in flight) drops the samples.
  session.audioData(Uint8Array.of(0x00));
  assert.deepEqual(calls.audio, [[0, 0]]);
});

test('hid buttons fire send_enter and undo_last_output on down edges only', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock);
  session.hidEvent({ button: 'select', isDown: true });
  session.hidEvent({ button: 'select', isDown: false });
  session.hidEvent({ button: 'back', isDown: true });
  session.hidEvent({ button: 'up', isDown: true }); // unmapped
  assert.deepEqual(calls.commands, ['send_enter', 'undo_last_output']);
});

test('tap mode: device lost cancels the active session', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock, { config: { voiceMode: 'tap' } });
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 5 }), session.atvv));
  clock.advance(200);
  session.controlEvent(parseControlEvent(audioStopPhysical(), session.atvv));
  assert.equal(session.phase, 'persistent');
  session.deviceLost();
  assert.deepEqual(calls.stopSession, [{ reason: 'device_lost', cancel: true }]);
  assert.equal(session.phase, 'idle');
  assert.equal(clock.pendingCount, 0);
});

test('teardown closes the mic and reports an active session', () => {
  const clock = new ManualClock();
  const { session, calls } = createDeviceSession(clock);
  session.controlEvent(parseControlEvent(audioStartPhysical({ streamId: 5 }), session.atvv));
  assert.equal(session.phase, 'holding'); // session started at key-down
  assert.equal(session.teardown(), true);
  assert.deepEqual(calls.writes.at(-1), [0x0d, 0x05]);
  assert.equal(session.phase, 'idle');
});

test('8 kHz codec output is upsampled to 16 kHz', () => {
  const clock = new ManualClock();
  const calls = { startSession: [], stopSession: [], commands: [], writes: [], audio: [], status: [] };
  const session = new DeviceSession({
    clock,
    hooks: {
      startSession: (mode, kind, initial) => calls.startSession.push({ mode, kind, initial: [...initial] }),
      stopSession: (reason) => calls.stopSession.push({ reason }),
      sendCommand: (command) => calls.commands.push(command),
      writeDevice: (bytes) => calls.writes.push([...bytes]),
      onAudio: (samples) => calls.audio.push([...samples]),
      onStatus: () => {}
    }
  });
  session.deviceReady({
    name: 'r',
    atvv: { version: '0.4', codecs: 0x01, codec: 0x01, frameSize: 7, sampleRate: 8000 },
    hidSubscribed: true
  });
  session.controlEvent(parseControlEvent(Uint8Array.of(0x04, 0x03), session.atvv));
  // v0.4 frame [pred=0, nibbles 0x77] -> [0, 11, 41]; upsampled x2 -> [0, 6, 11, 26, 41].
  // Hold mode forwards to the host session directly (no gesture buffer).
  session.audioData(v04Frame({ predictor: 0, stepIndex: 0, nibbles: Uint8Array.of(0x77) }));
  assert.deepEqual(calls.startSession, [{ mode: 'ptt', kind: 'hold', initial: [] }]);
  assert.deepEqual(calls.audio[0].slice(0, 3), [0, 6, 11]); // (0+11)/2 = 5.5 -> 6
  assert.equal(calls.audio[0].length, 5);
});

// ---------------------------------------------------------------------------
// BLE transport (fake send + manual clock).

test('uuidEquals matches short and full Bluetooth base UUID spellings', () => {
  assert.equal(uuidEquals('2A4D', '00002A4D-0000-1000-8000-00805F9B34FB'), true);
  assert.equal(uuidEquals('2a4d', '00002a4d00001000800000805f9b34fb'), true);
  assert.equal(uuidEquals('2A4D', '2A4D'), true);
  assert.equal(uuidEquals('AB5E0004-5A21-4F05-BC7D-AF01F617B664', 'ab5e00045a214f05bc7daf01f617b664'), true);
  assert.equal(uuidEquals('2A4D', '2A4E'), false);
  assert.equal(uuidEquals('2A4D', 'AB5E0004-5A21-4F05-BC7D-AF01F617B664'), false);
});

function createTransport(clock) {
  const sent = [];
  const events = { ready: [], notifications: [], lost: [], status: [] };
  const transport = new BleTransport({
    send: (message) => sent.push(message),
    onReady: (info) => events.ready.push(info),
    onNotification: (info) => events.notifications.push(info),
    onDeviceLost: (reason) => events.lost.push(reason),
    onStatus: (info) => events.status.push(info),
    clock
  });
  return { transport, sent, events };
}

/** Ack the newest `kind` request and flush the transport's async continuations. */
async function reply(transport, sent, kind) {
  const request = [...sent].reverse().find((message) => message.type === kind);
  assert.ok(request, `expected a ${kind} request`);
  transport.handleHostMessage({ type: 'ble_accepted', requestId: request.requestId });
  await delay(1);
  return request;
}

test('transport scans, connects, subscribes, and completes the ATVV handshake', async () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();

  const scan = await reply(transport, sent, 'ble_scan');
  assert.equal(scan.apiVersion, '1');
  assert.equal(scan.filter.serviceUuid, ATVV.service);
  assert.deepEqual(scan.filter.connectedServiceUuids, [ATVV.service, '1812', '180F']);

  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: 'dev-1', name: 'Chromecast Remote', serviceUuids: [ATVV.service] }]
  });
  const connect = await reply(transport, sent, 'ble_connect');
  assert.equal(connect.deviceId, 'dev-1');

  for (const expected of [ATVV.control, ATVV.audio, '2A4D', ATVV.command]) {
    const notify = [...sent].reverse().find((message) => message.type === 'ble_start_notify');
    assert.equal(uuidEquals(notify.characteristicUuid, expected), true, `expected ${expected}, got ${notify.characteristicUuid}`);
    transport.handleHostMessage({ type: 'ble_accepted', requestId: notify.requestId });
    await delay(1);
  }
  const caps = [...sent].reverse().find((message) => message.type === 'ble_write');
  assert.equal(caps.characteristicUuid, ATVV.command);
  assert.deepEqual([...Buffer.from(caps.dataBase64, 'base64')], [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]);
  transport.handleHostMessage({ type: 'ble_accepted', requestId: caps.requestId });
  await delay(1);

  // Capabilities arrive on the control characteristic.
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: ATVV.control,
    dataBase64: Buffer.from(capabilitiesV10()).toString('base64')
  });
  assert.equal(events.ready.length, 1);
  assert.equal(events.ready[0].atvv.version, '1.0');
  assert.equal(events.ready[0].atvv.codec, 0x02);
  assert.equal(events.ready[0].hidSubscribed, true);

  // Audio notifications are forwarded raw with the original UUID spelling.
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: 'ab5e0003-5a21-4f05-bc7d-af01f617b664',
    dataBase64: Buffer.from(Uint8Array.of(0x77)).toString('base64')
  });
  assert.equal(events.notifications.length, 1);
  assert.deepEqual([...events.notifications[0].data], [0x77]);
  // Short-form HID report notifications route to the optional channel.
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: '2A4D',
    dataBase64: Buffer.from(Uint8Array.of(0x01, 0x07)).toString('base64')
  });
  assert.equal(events.notifications.length, 2);
  assert.deepEqual([...events.notifications[1].data], [0x01, 0x07]);

  // Control events (non-capabilities) are forwarded after the handshake.
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: ATVV.control,
    dataBase64: Buffer.from(audioStartPhysical()).toString('base64')
  });
  assert.equal(events.notifications.length, 3);
  transport.stop();
});

test('adapter-unavailable rejection stops retries permanently', () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();
  const scan = [...sent].reverse().find((message) => message.type === 'ble_scan');
  transport.handleHostMessage({
    type: 'ble_rejected',
    requestId: scan.requestId,
    reason: 'failed',
    message: 'BLE adapter backend unavailable on this platform'
  });
  assert.equal(transport.started, false);
  assert.equal(events.status.at(-1).phase, 'error');
  clock.advance(60000);
  assert.equal(sent.filter((message) => message.type === 'ble_scan').length, 1); // no retry
});

test('connect rejection cleans up and retries with backoff', () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();
  const scan = [...sent].reverse().find((message) => message.type === 'ble_scan');
  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: 'dev-1', name: 'Chromecast Remote' }]
  });
  const connect = [...sent].reverse().find((message) => message.type === 'ble_connect');
  transport.handleHostMessage({ type: 'ble_rejected', requestId: connect.requestId, reason: 'busy' });
  // Idempotent disconnect cleanup was issued for the rejected device.
  assert.ok(sent.some((message) => message.type === 'ble_disconnect' && message.deviceId === 'dev-1'));
  assert.equal(events.status.some((info) => info.phase === 'backoff'), true);
  clock.advance(1000); // first backoff step -> new scan
  assert.equal(sent.filter((message) => message.type === 'ble_scan').length, 2);
  // The failed candidate is excluded from a repeated result.
  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: sent.at(-1).requestId,
    devices: [{ deviceId: 'dev-1', name: 'Chromecast Remote' }]
  });
  assert.equal(sent.filter((message) => message.type === 'ble_connect').length, 1);
});

test('device disconnect triggers reconnect and reports the loss', async () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();
  const scan = await reply(transport, sent, 'ble_scan');
  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: 'dev-9', name: 'Chromecast Remote' }]
  });
  await reply(transport, sent, 'ble_connect');
  for (let i = 0; i < 4; i++) await reply(transport, sent, 'ble_start_notify');
  await reply(transport, sent, 'ble_write');
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-9',
    characteristicUuid: ATVV.control,
    dataBase64: Buffer.from(capabilitiesV10()).toString('base64')
  });
  assert.equal(events.ready.length, 1);

  transport.handleHostMessage({ type: 'ble_disconnected', deviceId: 'dev-9', reason: 'link_lost' });
  assert.deepEqual(events.lost, ['link_lost']);
  clock.advance(1000);
  assert.equal(sent.filter((message) => message.type === 'ble_scan').length, 2);
});

test('HID short-form rejection falls back to the full UUID spelling', async () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();
  const scan = await reply(transport, sent, 'ble_scan');
  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: 'dev-1', name: 'Chromecast Remote' }]
  });
  await reply(transport, sent, 'ble_connect');
  await reply(transport, sent, 'ble_start_notify'); // control
  await reply(transport, sent, 'ble_start_notify'); // audio

  // The backend only knows the full form; the short form is rejected.
  const hidShort = [...sent].reverse().find((message) => message.type === 'ble_start_notify');
  assert.equal(hidShort.characteristicUuid, '2A4D');
  transport.handleHostMessage({ type: 'ble_rejected', requestId: hidShort.requestId, reason: 'not_found', message: 'BLE characteristic not found' });
  await delay(1); // flush the retry
  const hidLong = [...sent].reverse().find((message) => message.type === 'ble_start_notify');
  assert.equal(hidLong.characteristicUuid, '00002a4d-0000-1000-8000-00805f9b34fb');
  transport.handleHostMessage({ type: 'ble_accepted', requestId: hidLong.requestId });
  await delay(1);
  assert.equal(transport.started, true);

  await reply(transport, sent, 'ble_start_notify'); // command echo
  await reply(transport, sent, 'ble_write'); // getCapabilities
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: ATVV.control,
    dataBase64: Buffer.from(capabilitiesV10()).toString('base64')
  });
  assert.equal(events.ready.length, 1);
  assert.equal(events.ready[0].hidSubscribed, true);
});

test('HID unavailable in both spellings degrades gracefully without killing voice', async () => {
  const clock = new ManualClock();
  const { transport, sent, events } = createTransport(clock);
  transport.start();
  const scan = await reply(transport, sent, 'ble_scan');
  transport.handleHostMessage({
    type: 'ble_scan_result',
    requestId: scan.requestId,
    devices: [{ deviceId: 'dev-1', name: 'Chromecast Remote' }]
  });
  await reply(transport, sent, 'ble_connect');
  await reply(transport, sent, 'ble_start_notify'); // control
  await reply(transport, sent, 'ble_start_notify'); // audio
  for (const spelling of ['2A4D', '00002a4d-0000-1000-8000-00805f9b34fb']) {
    const hid = [...sent].reverse().find((message) => message.type === 'ble_start_notify');
    assert.equal(hid.characteristicUuid, spelling);
    transport.handleHostMessage({ type: 'ble_rejected', requestId: hid.requestId, reason: 'not_found', message: 'BLE characteristic not found' });
    await delay(1); // flush the retry chain
  }
  assert.equal(transport.started, true); // still operational
  assert.equal(events.status.some((info) => info.hidAvailable === false), true);
  await reply(transport, sent, 'ble_start_notify'); // command echo
  await reply(transport, sent, 'ble_write'); // getCapabilities
  transport.handleHostMessage({
    type: 'ble_notification',
    deviceId: 'dev-1',
    characteristicUuid: ATVV.control,
    dataBase64: Buffer.from(capabilitiesV10()).toString('base64')
  });
  assert.equal(events.ready.length, 1);
  assert.equal(events.ready[0].hidSubscribed, false);
});

// ---------------------------------------------------------------------------
// IOKit HID helper process management (fake helper scripts).
//
// The fakes are node scripts so SIGTERM terminates them directly and their
// stdio pipes close immediately; a shell + `sleep` child would leave orphaned
// pipe writers holding the event loop open.

async function writeFakeHelper(dir, name, script, executable = true) {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`, 'utf8');
  if (executable) await chmod(path, 0o755);
  return path;
}

test('hid helper: streams reports, restarts after crashes, gives up bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hid-helper-'));
  try {
    const selectReport = Buffer.from(Uint8Array.of(0x01, 0x07)).toString('base64'); // report ID + select
    const helperPath = await writeFakeHelper(
      dir,
      'crash.mjs',
      `process.stdout.write(JSON.stringify({ type: "hid_report", data: ${JSON.stringify(selectReport)} }) + "\\n");\n` +
        'process.exit(1);'
    );
    const reports = [];
    const statuses = [];
    const clock = {
      setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
      clearTimer: (handle) => clearTimeout(handle)
    };
    const source = new HidHelperSource({
      helperPath,
      buildArgs: () => ['--seize'],
      onReport: (bytes) => reports.push([...bytes]),
      onStatus: (info) => statuses.push(info),
      clock
    });
    await source.start();
    assert.ok(statuses.some((info) => info.running === true));
    // Every run prints one report then exits 1; respawns are bounded
    // (initial run + 3 restarts), then the source reports unavailable.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !statuses.some((info) => info.running === false && info.error)) {
      await delay(20);
    }
    assert.equal(reports.length, 4);
    assert.deepEqual(reports[0], [0x01, 0x07]); // report ID + select usage
    assert.equal(source.running, false);
    assert.ok(statuses.at(-1).error.includes('多次退出'));

    // After the give-up state, start() can bring it back.
    await source.start();
    const deadline2 = Date.now() + 2000;
    while (Date.now() < deadline2 && reports.length < 5) await delay(20);
    assert.ok(reports.length >= 5);
    source.stop();
    assert.equal(source.running, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hid helper: missing binary reports unavailable without crashing', async () => {
  const statuses = [];
  const source = new HidHelperSource({
    helperPath: '/nonexistent/vokie-hid-helper',
    buildArgs: () => [],
    onReport: () => {},
    onStatus: (info) => statuses.push(info)
  });
  await source.start();
  assert.equal(source.running, false);
  assert.equal(statuses.at(-1).running, false);
  assert.ok(statuses.at(-1).error.includes('不可执行'));
  source.stop(); // idempotent
});

test('hid helper: repairable executable bit is fixed automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hid-helper-'));
  try {
    const muteReport = Buffer.from(Uint8Array.of(0x01, 0x08)).toString('base64'); // report ID + mute
    const helperPath = await writeFakeHelper(
      dir,
      'idle-noexec.mjs',
      `process.stdout.write(JSON.stringify({ type: "hid_report", data: ${JSON.stringify(muteReport)} }) + "\\n");\n` +
        'setInterval(() => {}, 60000);',
      false // not executable on purpose
    );
    const reports = [];
    const source = new HidHelperSource({
      helperPath,
      buildArgs: () => [],
      onReport: (bytes) => reports.push([...bytes])
    });
    await source.start();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && reports.length < 1) await delay(20);
    assert.deepEqual(reports[0], [0x01, 0x08]); // report ID + mute usage (0x08)
    assert.equal(source.running, true);
    source.stop();
    assert.equal(source.running, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
