// Shared test helpers: a manual clock for timer-driven modules, a minimal
// RFC 6455 "Vokie Host" WebSocket server (text + binary frames), ATVV
// byte builders for a fake Chromecast Voice Remote, and a fake privileged
// HCI capture daemon with PacketLogger nhdr line builders.

import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic clock: setTimer/clearTimer/now with manual advance(). */
export class ManualClock {
  constructor(startAt = 0) {
    this.time = startAt;
    this.timers = [];
    this.nextId = 1;
  }
  now() {
    return this.time;
  }
  setTimer(fn, ms) {
    const id = this.nextId++;
    this.timers.push({ id, fn, at: this.time + ms });
    return id;
  }
  clearTimer(id) {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      this.time = due[0].at;
      this.clearTimer(due[0].id);
      due[0].fn();
    }
    this.time = target;
  }
  get pendingCount() {
    return this.timers.length;
  }
}

function createMessageHub() {
  const messages = [];
  const waiters = [];
  function push(message) {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(message)) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }
  function waitFor(predicate, label, timeoutMs = 5000, after = 0) {
    const found = messages.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }
  return { messages, push, waitFor };
}

function encodeWsTextFrame(payload) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decode one plugin audio frame: uint32be(headerLen) || headerJson || pcm. */
export function parseAudioFrame(buffer) {
  if (buffer.length < 4) throw new Error('audio frame too short');
  const headerLength = buffer.readUInt32BE(0);
  if (headerLength <= 0 || headerLength > 16 * 1024) throw new Error('invalid audio header length');
  const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  const pcm = buffer.subarray(4 + headerLength);
  return { header, pcm };
}

/** Minimal RFC 6455 server that plays the Vokie Host for one Worker. */
export class FakePluginHost {
  constructor() {
    this.http = createServer();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.hub = createMessageHub();
    this.binaryFrames = [];
    this.closed = false;
    this.http.on('upgrade', (request, socket, head) => {
      const key = request.headers['sec-websocket-key'];
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.setNoDelay(true);
      this.socket = socket;
      this.buffer = Buffer.concat([this.buffer, head]);
      this.drain();
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
      socket.on('close', () => {
        this.closed = true;
      });
      socket.on('error', () => {});
    });
  }
  listen() {
    return new Promise((resolve) => this.http.listen(0, '127.0.0.1', resolve));
  }
  close() {
    // Destroy the (possibly half-open) upgrade socket first; otherwise
    // server.close() waits forever for a dead peer's connection.
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      this.http.close(() => resolve());
    });
  }
  get port() {
    return this.http.address().port;
  }
  get messages() {
    return this.hub.messages;
  }
  sendJson(message) {
    this.socket.write(encodeWsTextFrame(Buffer.from(JSON.stringify(message))));
  }
  waitFor(predicate, label, timeoutMs = 5000, after = 0) {
    return this.hub.waitFor(predicate, label, timeoutMs, after);
  }
  drain() {
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 0x1) {
        try {
          this.hub.push(JSON.parse(frame.payload.toString('utf8')));
        } catch {
          this.hub.push({ type: 'malformed_text', length: frame.payload.length });
        }
      } else if (frame.opcode === 0x2) {
        let parsed;
        try {
          parsed = { type: 'audio_frame', ...parseAudioFrame(frame.payload) };
        } catch (error) {
          parsed = { type: 'audio_frame_malformed', error: error.message };
        }
        this.binaryFrames.push(frame.payload);
        this.hub.push(parsed);
      } else if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.subarray(0, 2) : Buffer.from([0x03, 0xe8]);
        this.socket.write(Buffer.concat([Buffer.from([0x88, code.length]), code]));
        this.socket.end();
      }
    }
  }
  readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) return null;
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buffer.subarray(offset + length);
    return { opcode, payload };
  }
}

// ---------------------------------------------------------------------------
// Fake Chromecast Voice Remote: ATVV byte builders.

export const ATVV = {
  service: 'AB5E0001-5A21-4F05-BC7D-AF01F617B664',
  command: 'AB5E0002-5A21-4F05-BC7D-AF01F617B664',
  audio: 'AB5E0003-5A21-4F05-BC7D-AF01F617B664',
  control: 'AB5E0004-5A21-4F05-BC7D-AF01F617B664',
  hidReport: '00002A4D-0000-1000-8000-00805F9B34FB'
};

export function capabilitiesV10({ codecs = 0x02, interaction = 0x00, frameSize = 161 } = {}) {
  return Uint8Array.of(0x0b, 0x01, 0x00, codecs, interaction, (frameSize >> 8) & 0xff, frameSize & 0xff);
}

export function capabilitiesV04({ codecs = 0x02, frameSize = 161 } = {}) {
  // v0.4 payload carries two trailing reserved bytes (vRemoter requires >= 9).
  return Uint8Array.of(0x0b, 0x00, 0x04, 0x00, codecs, (frameSize >> 8) & 0xff, frameSize & 0xff, 0x00, 0x00);
}

export function audioStartPhysical({ streamId = 1, codec = 0x02 } = {}) {
  return Uint8Array.of(0x04, 0x03, codec, streamId);
}

export function audioStartHost({ streamId = 2, codec = 0x02 } = {}) {
  return Uint8Array.of(0x04, 0x00, codec, streamId);
}

export function audioStopPhysical() {
  return Uint8Array.of(0x00, 0x02);
}

export function audioStopGeneric(reason = 0x00) {
  return Uint8Array.of(0x00, reason);
}

export function audioSync({ codec = 0x02, sequence = 0, predictor = 0, stepIndex = 0 } = {}) {
  return Uint8Array.of(
    0x0a, codec,
    (sequence >> 8) & 0xff, sequence & 0xff,
    (predictor >> 8) & 0xff, predictor & 0xff,
    stepIndex
  );
}

export function micOpenError(code = 0x0001) {
  return Uint8Array.of(0x0c, (code >> 8) & 0xff, code & 0xff);
}

/** v0.4 self-contained audio frame. */
export function v04Frame({ sequence = 0, predictor = 0, stepIndex = 0, nibbles = Uint8Array.of(0x77, 0x00) } = {}) {
  const bytes = new Uint8Array(6 + nibbles.length);
  bytes[0] = (sequence >> 8) & 0xff;
  bytes[1] = sequence & 0xff;
  bytes[3] = (predictor >> 8) & 0xff;
  bytes[4] = predictor & 0xff;
  bytes[5] = stepIndex;
  bytes.set(nibbles, 6);
  return bytes;
}

/** HID input report with report ID 0x01 prefix. */
export function hidReport(usage) {
  return Uint8Array.of(0x01, usage);
}

// ---------------------------------------------------------------------------
// Fake privileged HCI capture daemon (protocol `vokie.appleTvRemote.hci` v2)
// and PacketLogger nhdr line builders, mirroring the real root daemon
// (/var/run/com.vokie.hci.sock) used for button capture on macOS 26.5.

/**
 * Build one PacketLogger nhdr line carrying an ATT Handle-Value Notification
 * inside an ACL packet, like `packetlogger convert -s -f nhdr` prints them:
 * `<month> <day> <time> <device name> <0xconn-handle> RECV <hex bytes…>`.
 */
export function nhdrAttLine({
  device = 'Chromecast Remote',
  connHandle = 0x000c,
  gattHandle,
  value,
  direction = 'RECV'
} = {}) {
  const l2cap = [0x1b, gattHandle & 0xff, (gattHandle >> 8) & 0xff, ...value];
  const bytes = [
    connHandle & 0xff, ((connHandle | 0x2000) >> 8) & 0xff, // PB flag = 2
    (l2cap.length + 4) & 0xff, (l2cap.length + 4) >> 8, // ACL includes the L2CAP header
    l2cap.length & 0xff, (l2cap.length >> 8) & 0xff, // L2CAP length
    0x04, 0x00, // ATT CID
    ...l2cap
  ];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return `Sep 13 12:00:00.123456 ${device} 0x${connHandle.toString(16).padStart(4, '0')} ${direction} ${hex}`;
}

export const HCI_BUTTON_GATT_HANDLE = 0x002b;
export function nhdrSelectDown() {
  return nhdrAttLine({ gattHandle: HCI_BUTTON_GATT_HANDLE, value: [0x41, 0x00] });
}
export function nhdrBackDown() {
  return nhdrAttLine({ gattHandle: HCI_BUTTON_GATT_HANDLE, value: [0x24, 0x02] });
}
export function nhdrButtonUp() {
  return nhdrAttLine({ gattHandle: HCI_BUTTON_GATT_HANDLE, value: [0x00, 0x00] });
}

export class FakeHciDaemon {
  constructor({ version = '2', captureAllowed = true, unavailableMessage = 'another capture is active' } = {}) {
    this.version = version;
    this.captureAllowed = captureAllowed;
    this.unavailableMessage = unavailableMessage;
    this.requests = [];
    this.sockets = [];
    this.capturing = false;
    this.server = createNetServer((socket) => this.#accept(socket));
  }

  listen(path) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(path, () => resolve());
    });
  }

  async close() {
    for (const socket of this.sockets.splice(0)) socket.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  sendNhdr(line) {
    this.#send({ type: 'nhdr', captureId: 'fake', line });
  }

  stopCapture() {
    this.capturing = false;
    this.#send({ type: 'captureStopped', captureId: 'fake' });
  }

  #accept(socket) {
    this.sockets.push(socket);
    socket.setEncoding('utf8');
    // Mirror the real daemon: the capture is owned by its client connection
    // and stops when that connection drops.
    socket.on('close', () => {
      this.sockets = this.sockets.filter((item) => item !== socket);
      this.capturing = false;
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.#handleRequest(line, socket);
      }
    });
  }

  #handleRequest(line, socket) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    this.requests.push(request);
    switch (request.command) {
      case 'startCapture':
        if (!this.captureAllowed) {
          this.capturing = false;
          socket.write(JSON.stringify({ type: 'captureUnavailable', message: this.unavailableMessage, id: request.id }) + '\n');
          return;
        }
        this.capturing = true;
        socket.write(JSON.stringify({ type: 'captureStarted', captureId: request.captureId, id: request.id }) + '\n');
        return;
      case 'stopCapture':
        this.capturing = false;
        socket.write(JSON.stringify({ type: 'captureStopped', captureId: request.captureId, id: request.id }) + '\n');
        return;
      case 'health':
      case 'version':
        socket.write(JSON.stringify({ type: 'ready', version: this.version, id: request.id }) + '\n');
        return;
      default:
        socket.write(JSON.stringify({ type: 'error', message: 'unknown command', id: request.id }) + '\n');
    }
  }

  #send(object) {
    const payload = JSON.stringify(object) + '\n';
    for (const socket of this.sockets) socket.write(payload);
  }
}
