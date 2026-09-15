// HID UUID selects the peripheral; an ATT serial read plus CoreBluetooth's
// matching callback proves its HCI handle. Ordinary notifications cannot bind it.
export function parseTraceLine(line) {
  if (typeof line !== 'string') return null;
  const tokens = line.split(/[ \t]+/).filter(Boolean);
  const index = tokens.findIndex(token => /^(RECV|SEND)$/i.test(token));
  if (index < 5) return null;
  const bytes = [];
  for (const token of tokens.slice(index + 1)) {
    const clean = token.replace(/[,:]$/, '');
    if (!clean || clean === ':') continue;
    if (!/^[a-f\d]{2}$/i.test(clean)) return null;
    bytes.push(parseInt(clean, 16));
  }
  return { source: tokens.slice(3, index - 1).join(' '), received: tokens[index].toUpperCase() === 'RECV', bytes };
}

export function attPacket(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 9) return null;
  const header = bytes[0] | bytes[1] << 8;
  const boundary = header >> 12 & 3;
  const length = bytes[2] | bytes[3] << 8;
  const attLength = bytes[4] | bytes[5] << 8;
  if (![0, 2].includes(boundary) || bytes.length !== length + 4 || length !== attLength + 4 || bytes[6] !== 4 || bytes[7] !== 0) return null;
  return { handle: header & 0xfff, value: bytes.slice(8) };
}

export class HciIdentity {
  constructor() { this.reset(); }
  reset() {
    this.connectionHandle = null;
    this.serial = [];
    this.deadline = 0;
    this.confirmed = false;
    this.requests = new Set();
    this.candidates = new Set();
  }
  begin(serial, now) {
    this.reset();
    this.serial = [...Buffer.from(serial)];
    this.deadline = now + 3000;
  }
  confirm(value, now) {
    if (now > this.deadline || this.serial.length < 6 || !Buffer.from(value).equals(Buffer.from(this.serial))) return;
    this.confirmed = true;
    this.bind();
  }
  observe(bytes, received, now) {
    if (received && bytes.length === 6 && bytes[0] === 5 && bytes[1] === 4) {
      const handle = bytes[3] | bytes[4] << 8;
      if (handle === this.connectionHandle || this.candidates.has(handle)) this.reset();
      return;
    }
    if (now > this.deadline || this.serial.length < 6) return;
    const packet = attPacket(bytes);
    if (!packet) return;
    if (!received && packet.value.length === 3 && packet.value[0] === 0x0a) {
      this.requests.add(packet.handle);
    } else if (received && packet.value[0] === 0x0b && this.requests.delete(packet.handle) &&
        Buffer.from(packet.value.slice(1)).equals(Buffer.from(this.serial))) {
      this.candidates.add(packet.handle);
      this.bind();
    } else if (received && packet.value[0] === 1) {
      this.requests.delete(packet.handle);
    }
  }
  bind() {
    this.connectionHandle = this.confirmed && this.candidates.size === 1 ? [...this.candidates][0] : null;
  }
  accepts(bytes) {
    return this.connectionHandle !== null && attPacket(bytes)?.handle === this.connectionHandle;
  }
}
