// Vokie session bookkeeping: one session request at a time, request-id
// correlation, ordered audio frames, and the pre-acceptance buffer.
//
// Frames are `uint32be(headerUtf8ByteLength) || headerUtf8 || pcm` with
// 16 kHz mono pcm_s16le PCM and a per-request sequence starting at zero.
// Audio fed before session_accepted is buffered (bounded, drop-oldest) and
// flushed in order on acceptance; audio with no session in flight is dropped.

import { randomUUID } from 'node:crypto';
import { BoundedPcmBuffer, encodeAudioFrame, pcmToBytes } from './pcm.mjs';

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz — flush chunk size

export class HostSession {
  constructor({ sendJson, sendBinary } = {}) {
    if (typeof sendJson !== 'function' || typeof sendBinary !== 'function') {
      throw new Error('sendJson and sendBinary are required');
    }
    this.#sendJson = sendJson;
    this.#sendBinary = sendBinary;
    this.#buffer = new BoundedPcmBuffer();
    this.#clear();
  }

  #sendJson;
  #sendBinary;
  #buffer;
  #requestId = null;
  #mode = null;
  #accepted = false;
  #sequence = 0;
  #totalFrames = 0; // cumulative across sessions, for end-cause diagnostics

  get active() {
    return this.#requestId !== null;
  }

  get mode() {
    return this.#mode;
  }

  get accepted() {
    return this.#accepted;
  }

  /** Cumulative audio frames sent since worker start (diagnostics). */
  get totalFrames() {
    return this.#totalFrames;
  }

  #clear() {
    this.#requestId = null;
    this.#mode = null;
    this.#accepted = false;
    this.#sequence = 0;
    this.#buffer.clear();
  }

  /** Start a session request. Ends any lingering request first (defensive). */
  begin(mode, initialSamples = null) {
    if (this.active) this.end('superseded');
    this.#requestId = randomUUID();
    this.#mode = mode;
    this.#accepted = false;
    this.#sequence = 0;
    if (initialSamples?.length) this.#buffer.push(initialSamples);
    this.#sendJson({
      type: 'session_start',
      requestId: this.#requestId,
      mode,
      timestampMs: Date.now(),
      options: {
        audioSource: { type: 'stream', format: 'pcm_s16le', sampleRate: 16000, channels: 1 }
      }
    });
    return this.#requestId;
  }

  /** Route decoded samples; buffers until accepted, drops without a session. */
  feed(samples) {
    if (!this.active) return;
    if (!this.#accepted) {
      this.#buffer.push(samples);
      return;
    }
    this.#emit(samples);
  }

  accepted(requestId) {
    if (!this.active || (requestId !== undefined && requestId !== this.#requestId)) return false;
    this.#accepted = true;
    const buffered = this.#buffer.drain();
    if (buffered.length) this.#emit(buffered);
    return true;
  }

  rejected(requestId) {
    if (!this.active || (requestId !== undefined && requestId !== this.#requestId)) return false;
    this.#clear();
    return true;
  }

  /** The Host finished/aborted the session on its own (terminal session_state). */
  hostEnded(requestId) {
    return this.rejected(requestId);
  }

  end(reason = 'device', { cancel = false } = {}) {
    if (!this.active) return null;
    const requestId = this.#requestId;
    const message = cancel
      ? { type: 'session_cancel', requestId, timestampMs: Date.now(), reason }
      : { type: 'session_stop', requestId, timestampMs: Date.now(), reason };
    this.#clear();
    this.#sendJson(message);
    return requestId;
  }

  #emit(samples) {
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
      const end = Math.min(offset + FRAME_SAMPLES, samples.length);
      const pcm = pcmToBytes(samples, offset, end);
      if (pcm.length) {
        this.#sendBinary(encodeAudioFrame(this.#requestId, this.#sequence++, pcm));
        this.#totalFrames += 1;
      }
    }
  }
}
