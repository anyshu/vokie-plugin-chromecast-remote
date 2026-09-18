// Google ATVV (Android TV Voice) BLE protocol codec for the Chromecast Voice
// Remote. Wire format and state machine semantics follow the reference
// implementation in VincentKingHsu/vRemoter (MIT), simplified to the pieces a
// Vokie plugin needs: capabilities negotiation, mic open/close, keep-alive,
// control events, and ADPCM audio frames.
//
// Characteristic roles (as wired by vRemoter's BLEBridge):
//   AB5E0002  command  — host writes commands to the remote
//   AB5E0003  audio    — remote streams ADPCM voice frames (notify)
//   AB5E0004  control  — remote sends control events (notify)

export const ATVV_SERVICE_UUID = 'AB5E0001-5A21-4F05-BC7D-AF01F617B664';
export const ATVV_COMMAND_UUID = 'AB5E0002-5A21-4F05-BC7D-AF01F617B664';
export const ATVV_AUDIO_UUID = 'AB5E0003-5A21-4F05-BC7D-AF01F617B664';
export const ATVV_CONTROL_UUID = 'AB5E0004-5A21-4F05-BC7D-AF01F617B664';

export const ATVV_VERSION_V04 = '0.4';
export const ATVV_VERSION_V10 = '1.0';

export const ATVV_CODEC_ADPCM_8K = 0x01;
export const ATVV_CODEC_ADPCM_16K = 0x02;

// Control opcodes sent by the remote.
const OPCODE_AUDIO_STOP = 0x00;
const OPCODE_AUDIO_START = 0x04;
const OPCODE_START_SEARCH = 0x08;
const OPCODE_AUDIO_SYNC = 0x0a;
const OPCODE_CAPABILITIES = 0x0b;
const OPCODE_MIC_OPEN_ERROR = 0x0c;

// The Chromecast Voice Remote reserves these reasons for the physical voice
// key: 0x03 marks a device-initiated stream while the key is held, 0x02 marks
// the key release that ends it (verified in vRemoter's session coordinator).
export const ATVV_REASON_PHYSICAL_START = 0x03;
export const ATVV_REASON_PHYSICAL_STOP = 0x02;

// Host -> remote command frames.
export const GET_CAPABILITIES_COMMAND = Uint8Array.of(0x0a, 0x01, 0x00, 0x00, 0x03, 0x03);

export function micOpenCommand(version, codec) {
  if (!version) throw new Error('ATVV capabilities not negotiated');
  // v1.0 omits the codec; the remote uses the negotiated default.
  return version === ATVV_VERSION_V04
    ? Uint8Array.of(0x0c, 0x00, codec)
    : Uint8Array.of(0x0c, 0x00);
}

export function micCloseCommand(version, streamId) {
  if (!version) throw new Error('ATVV capabilities not negotiated');
  return version === ATVV_VERSION_V04
    ? Uint8Array.of(0x0d)
    : Uint8Array.of(0x0d, streamId);
}

export function keepAliveCommand(version, streamId, codec) {
  if (!version) throw new Error('ATVV capabilities not negotiated');
  return version === ATVV_VERSION_V04
    ? micOpenCommand(version, codec)
    : Uint8Array.of(0x0e, streamId);
}

/**
 * @param {Uint8Array} bytes raw control notification
 * @param {{version?: string, codec?: number}|null} session negotiated state
 * @returns control event or null when undecodable
 */
export function parseControlEvent(bytes, session) {
  if (!bytes.length) return null;
  const opcode = bytes[0];
  switch (opcode) {
    case OPCODE_AUDIO_STOP:
      return { type: 'audio_stop', reason: bytes.length > 1 ? bytes[1] : 0 };
    case OPCODE_AUDIO_START: {
      if (session?.version === ATVV_VERSION_V10) {
        if (bytes.length !== 4) return { type: 'unknown', bytes };
        return {
          type: 'audio_start',
          reason: bytes[1],
          codec: bytes[2],
          streamId: bytes[3]
        };
      }
      return {
        type: 'audio_start',
        reason: bytes.length > 1 ? bytes[1] : 0,
        codec: session?.codec ?? ATVV_CODEC_ADPCM_8K,
        streamId: 0
      };
    }
    case OPCODE_START_SEARCH:
      return { type: 'start_search' };
    case OPCODE_AUDIO_SYNC: {
      if (session?.version !== ATVV_VERSION_V10 || bytes.length < 7) return { type: 'unknown', bytes };
      const predictorBits = (bytes[4] << 8) | bytes[5];
      return {
        type: 'audio_sync',
        codec: bytes[1],
        sequence: (bytes[2] << 8) | bytes[3],
        predictor: (predictorBits << 16) >> 16, // int16
        stepIndex: bytes[6]
      };
    }
    case OPCODE_CAPABILITIES: {
      const capabilities = parseCapabilities(bytes);
      return capabilities ? { type: 'capabilities', capabilities } : { type: 'unknown', bytes };
    }
    case OPCODE_MIC_OPEN_ERROR:
      return bytes.length >= 3
        ? { type: 'mic_open_error', code: (bytes[1] << 8) | bytes[2] }
        : { type: 'mic_open_error', code: 0xffff };
    default:
      return { type: 'unknown', bytes };
  }
}

/**
 * Capabilities payload (opcode 0x0b):
 *   v0.4: [0B versionHi versionLo rsvd codecs frameHi frameLo ...]
 *   v1.0: [0B versionHi versionLo codecs interaction frameHi frameLo ...]
 */
export function parseCapabilities(bytes) {
  if (bytes.length < 3 || bytes[0] !== OPCODE_CAPABILITIES) return null;
  const version = (bytes[1] << 8) | bytes[2];
  if (version === 0x0004 && bytes.length >= 9) {
    return {
      version: ATVV_VERSION_V04,
      codecs: bytes[4],
      interactionModel: 0,
      frameSize: (bytes[5] << 8) | bytes[6]
    };
  }
  if (version === 0x0100 && bytes.length >= 7) {
    return {
      version: ATVV_VERSION_V10,
      codecs: bytes[3],
      interactionModel: bytes[4],
      frameSize: (bytes[5] << 8) | bytes[6],
      // The physical-stream MIC_EXTEND behavior was verified only with the
      // complete nine-byte v1 capability response used by the remote.
      physicalKeepAliveSupported: bytes.length >= 9
    };
  }
  return null;
}

export function selectCodec(capabilities) {
  if (!capabilities) return null;
  if (capabilities.codecs & ATVV_CODEC_ADPCM_16K) return ATVV_CODEC_ADPCM_16K;
  if (capabilities.codecs & ATVV_CODEC_ADPCM_8K) return ATVV_CODEC_ADPCM_8K;
  return null;
}

export function codecSampleRate(codec) {
  return codec === ATVV_CODEC_ADPCM_16K ? 16000 : 8000;
}

/**
 * Per-stream ATVV decoder state. One instance per device connection; reset on
 * every new audio stream.
 *
 * v0.4 frames are self-contained: [seqHi seqLo rsvd predHi predLo stepIdx nibbles...]
 * with frameSize bytes exactly; each frame restarts the ADPCM decoder and the
 * predictor sample is part of the output.
 * v1.0 frames are raw ADPCM bytes carrying a running decoder; sequence numbers
 * increment locally and AUDIO_SYNC supplies the decoder state.
 */
export class AtvvAudioDecoder {
  constructor() {
    this.reset();
  }

  reset(predictor = 0, stepIndex = 0) {
    this.predictor = predictor;
    this.stepIndex = Math.min(88, Math.max(0, stepIndex));
    this.v10Sequence = 0;
    this.hasPendingSync = false;
  }

  applySync({ predictor, stepIndex }) {
    this.reset(predictor, stepIndex);
    this.hasPendingSync = true;
  }

  beginStream() {
    if (!this.hasPendingSync) this.reset();
    this.hasPendingSync = false;
  }

  /**
   * @param {Uint8Array} bytes raw audio notification
   * @param {object} session negotiated capabilities {version, frameSize}
   * @returns {{sequence: number, samples: Int16Array}|null}
   */
  decode(bytes, session) {
    if (!session) return null;
    if (session.version === ATVV_VERSION_V04) {
      if (bytes.length !== session.frameSize || bytes.length < 6) return null;
      const predictorBits = (bytes[3] << 8) | bytes[4];
      const predictor = (predictorBits << 16) >> 16;
      this.reset(predictor, bytes[5]);
      const nibbleCount = bytes.length - 6;
      const samples = new Int16Array(nibbleCount * 2 + 1);
      samples[0] = predictor;
      this.#decodeNibbles(bytes.subarray(6), samples, 1);
      return { sequence: (bytes[0] << 8) | bytes[1], samples };
    }
    if (session.version === ATVV_VERSION_V10) {
      if (!bytes.length) return null;
      const samples = new Int16Array(bytes.length * 2);
      this.#decodeNibbles(bytes, samples, 0);
      return { sequence: this.v10Sequence++, samples };
    }
    return null;
  }

  #decodeNibbles(bytes, out, offset) {
    for (let i = 0; i < bytes.length; i++) {
      out[offset++] = this.#decodeNibble(bytes[i] >> 4);
      out[offset++] = this.#decodeNibble(bytes[i] & 0x0f);
    }
  }

  #decodeNibble(nibble) {
    const step = STEP_TABLE[this.stepIndex];
    let difference = step >> 3;
    if (nibble & 4) difference += step;
    if (nibble & 2) difference += step >> 1;
    if (nibble & 1) difference += step >> 2;
    this.predictor += nibble & 8 ? -difference : difference;
    if (this.predictor > 32767) this.predictor = 32767;
    else if (this.predictor < -32768) this.predictor = -32768;
    this.stepIndex += INDEX_TABLE[nibble & 7];
    if (this.stepIndex > 88) this.stepIndex = 88;
    else if (this.stepIndex < 0) this.stepIndex = 0;
    return this.predictor;
  }
}

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2494, 2740, 3008, 3307, 3638, 4002, 4402, 4842, 5327,
  5860, 6446, 7091, 7800, 8580, 9438, 10382, 11420, 12562, 13818,
  15200, 16720, 18392, 20231, 22254, 24479, 26927, 29620, 32767
];
