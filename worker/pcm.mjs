// PCM helpers: Vokie requires ordered 16 kHz mono signed-16 little-endian
// frames, while the remote negotiates 8 kHz or 16 kHz ADPCM.

/** Linear-interpolation upsample by an integer factor (8 kHz -> 16 kHz). */
export function upsampleX2(samples) {
  if (!samples.length) return samples;
  const out = new Int16Array(samples.length * 2 - 1);
  out[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    out[i * 2 - 1] = Math.round((previous + current) / 2);
    out[i * 2] = current;
  }
  return out;
}

/** Int16 samples -> little-endian PCM byte buffer. */
export function pcmToBytes(samples, from = 0, to = samples.length) {
  const bytes = Buffer.allocUnsafe((to - from) * 2);
  for (let i = from; i < to; i++) {
    bytes.writeInt16LE(samples[i], (i - from) * 2);
  }
  return bytes;
}

/**
 * Encode one Vokie plugin audio frame:
 *   uint32be(headerUtf8ByteLength) || headerUtf8 || pcm
 * @param {string} requestId session request id
 * @param {number} sequence per-request frame sequence, starting at zero
 * @param {Buffer} pcm signed 16-bit LE mono 16 kHz bytes
 */
export function encodeAudioFrame(requestId, sequence, pcm) {
  if (!pcm.length || pcm.length % 2) throw new Error('audio frame must be non-empty even-byte PCM');
  const header = Buffer.from(
    JSON.stringify({ type: 'audio', requestId, sequence, sampleRate: 16000, channels: 1, format: 'pcm_s16le' }),
    'utf8'
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, pcm]);
}

/**
 * Bounded pre-acceptance PCM buffer. The remote starts streaming the moment
 * the voice key is pressed, which can precede session acceptance (hold
 * disambiguation window plus the Host round trip). Overflow policy: when the
 * cap is reached the oldest samples are dropped, so at most
 * `maxMilliseconds` of the most recent audio is retained.
 */
export class BoundedPcmBuffer {
  constructor(maxMilliseconds = 2000) {
    this.maxSamples = Math.floor((16000 * maxMilliseconds) / 1000);
    this.chunks = [];
    this.total = 0;
  }

  push(samples) {
    if (!samples.length) return;
    this.chunks.push(samples);
    this.total += samples.length;
    while (this.total > this.maxSamples && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.total -= dropped.length;
    }
    if (this.chunks.length === 1 && this.total > this.maxSamples) {
      const overflow = this.total - this.maxSamples;
      this.chunks[0] = this.chunks[0].subarray(overflow);
      this.total = this.maxSamples;
    }
  }

  drain() {
    if (!this.chunks.length) return new Int16Array(0);
    const merged = new Int16Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.total = 0;
    return merged;
  }

  get length() {
    return this.total;
  }

  clear() {
    this.chunks = [];
    this.total = 0;
  }
}
