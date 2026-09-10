// Voice-key gesture handling for the Chromecast Voice Remote.
//
// The remote's voice key does not surface through HID; gestures arrive as
// ATVV control events instead (verified against vRemoter):
//
//   key down   -> AUDIO_START reason 0x03   (device streams while held)
//   key up     -> AUDIO_STOP  reason 0x02
//   host mic   -> AUDIO_START reason != 0x03 (persistent stream after micOpen)
//
// The plugin performs NO gesture-duration interpretation. The single
// voiceMode setting decides how the key behaves, and the worker just follows
// it:
//
//   'hold' 长按模式 (ptt): the key IS a push-to-talk button. Key-down starts
//     a `ptt` session immediately (audio during the acceptance round-trip is
//     buffered by the host session); key-up stops it. A quick tap is simply
//     a very short session.
//   'tap' 短按模式 (handsfree-ptt): every complete press-release cycle
//     toggles recording. The first press starts a `handsfree-ptt` session
//     and converts the brief physical stream into a host-initiated
//     persistent stream via MIC_OPEN; the next press closes it via
//     MIC_CLOSE.
//
// Audio is decoded here (ADPCM -> 16 kHz mono Int16 samples, resampling 8 kHz
// output) and forwarded; the host-session module owns request correlation and
// pre-acceptance buffering. In tap mode the press audio is buffered locally
// (bounded, drop-oldest) and handed over when the session begins at release.

import {
  ATVV_REASON_PHYSICAL_START,
  ATVV_REASON_PHYSICAL_STOP,
  AtvvAudioDecoder,
  micCloseCommand,
  micOpenCommand,
  keepAliveCommand,
  codecSampleRate
} from './atvv-protocol.mjs';
import { BoundedPcmBuffer, upsampleX2 } from './pcm.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  // 语音键模式，二选一，决定语音键的行为与会话类型。插件不做任何手势
  // 时长判定——只按用户选择的模式执行：
  //   'hold' 长按模式 —— 语音键即 PTT：按下立即开启 ptt 会话录音，抬起
  //         结束（快速点按只是一次很短的 ptt 会话）。
  //   'tap'  短按模式 —— 语音键即 Hands-free PTT：每次按下-抬起切换录音
  //         开关（handsfree-ptt 会话）。
  voiceMode: 'hold'
});

const KEEP_ALIVE_INTERVAL_MS = 4000;
const MIC_OPEN_CONFIRM_TIMEOUT_MS = 1000;
const MIC_OPEN_MAX_ATTEMPTS = 3;

/**
 * @param {object} options
 * @param {object} [options.config] {voiceMode: 'hold' | 'tap'}
 * @param {object} [options.clock] injectable {now(), setTimer(fn, ms), clearTimer(handle)}
 * @param {object} options.hooks
 * @param {(mode: string, kind: string, initialSamples: Int16Array) => void} options.hooks.startSession
 * @param {(reason: string, options?: {cancel?: boolean}) => void} options.hooks.stopSession
 * @param {(command: 'send_enter'|'undo_last_output') => void} options.hooks.sendCommand
 * @param {(bytes: Uint8Array) => void} options.hooks.writeDevice
 * @param {(samples: Int16Array) => void} options.hooks.onAudio
 * @param {(status: object) => void} options.hooks.onStatus
 */
export class DeviceSession {
  constructor({ config, clock, hooks } = {}) {
    this.#clock = clock ?? {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle)
    };
    this.#hooks = {
      startSession: hooks?.startSession ?? (() => {}),
      stopSession: hooks?.stopSession ?? (() => {}),
      sendCommand: hooks?.sendCommand ?? (() => {}),
      writeDevice: hooks?.writeDevice ?? (() => {}),
      onAudio: hooks?.onAudio ?? (() => {}),
      onStatus: hooks?.onStatus ?? (() => {})
    };
    this.#config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    this.#decoder = new AtvvAudioDecoder();
    this.#gestureBuffer = new BoundedPcmBuffer();
    this.reset();
  }

  #clock;
  #hooks;
  #config;
  #decoder;
  #gestureBuffer;

  // 'idle' | 'pressing' | 'holding' | 'persistent'
  phase = 'idle';
  atvv = null; // negotiated {version, codec, frameSize}
  deviceName = null;
  hidSubscribed = false;

  #gesture = null; // {startedAt, sessionWasActive}
  #streamActive = false;
  #streamId = 0;
  #sessionMode = null;
  #keepAliveTimer = null;
  #micOpenTimer = null;
  #micOpenAttempts = 0;
  #hostStreamConfirmed = false;

  get status() {
    return {
      phase: this.phase,
      streamActive: this.#streamActive,
      sessionMode: this.#sessionMode,
      hostStreamConfirmed: this.#hostStreamConfirmed
    };
  }

  setConfig(config) {
    this.#config = { ...this.#config, ...config };
  }

  reset() {
    this.#clearGestureTimers();
    this.#gesture = null;
    this.#streamActive = false;
    this.#streamId = 0;
    this.#sessionMode = null;
    this.#hostStreamConfirmed = false;
    this.#micOpenAttempts = 0;
    this.phase = 'idle';
    this.#gestureBuffer.clear();
    this.#decoder.reset();
  }

  deviceReady({ name, atvv, hidSubscribed }) {
    this.reset();
    this.atvv = atvv;
    this.deviceName = name ?? null;
    this.hidSubscribed = hidSubscribed === true;
  }

  deviceLost() {
    const hadSession = this.#sessionMode !== null;
    this.reset();
    if (hadSession) this.#hooks.stopSession('device_lost', { cancel: true });
  }

  /** Graceful teardown on plugin stop: MIC_CLOSE then reset. Returns whether a session was active. */
  teardown() {
    if (this.#streamActive) this.#writeMicClose();
    const hadSession = this.#sessionMode !== null;
    this.reset();
    return hadSession;
  }

  /** Full teardown on plugin stop/shutdown. */
  stop() {
    this.reset();
  }

  controlEvent(event) {
    if (!event || !this.atvv) return;
    switch (event.type) {
      case 'audio_start':
        return this.#audioStart(event);
      case 'audio_stop':
        return this.#audioStop(event);
      case 'audio_sync':
        this.#decoder.applySync(event);
        return;
      case 'mic_open_error':
        return this.#micOpenFailed(`MIC_OPEN_ERROR 0x${event.code.toString(16)}`);
      case 'start_search':
        // The Chromecast remote reports voice gestures through AUDIO_START
        // reason 0x03; START_SEARCH is informational here.
        return;
      default:
        return;
    }
  }

  audioData(bytes) {
    if (!this.#streamActive || !this.atvv) return;
    const frame = this.#decoder.decode(bytes, this.atvv);
    if (!frame || !frame.samples.length) return;
    const samples = this.#resample(frame.samples);
    if (this.phase === 'pressing') {
      this.#gestureBuffer.push(samples);
      return;
    }
    // holding / persistent: the host session owns buffering until acceptance.
    this.#hooks.onAudio(samples);
  }

  hidEvent({ button, isDown }) {
    // Buttons are routed from either the GATT subscription or the IOKit
    // helper; both refer to the same physical remote, so they are valid even
    // while the ATVV voice link is reconnecting.
    if (!isDown) return; // commands fire on key-down edges only
    if (button === 'select') this.#hooks.sendCommand('send_enter');
    else if (button === 'back') this.#hooks.sendCommand('undo_last_output');
  }

  sessionAccepted() {
    this.#log(`session accepted (mode=${this.#sessionMode})`);
    this.#hooks.onStatus({ sessionAccepted: true, sessionMode: this.#sessionMode });
  }

  sessionRejected(reason) {
    this.#log(`session rejected: ${reason} (phase=${this.phase})`);
    if (this.phase === 'persistent') {
      // Tap conversion failed at the Host; release the remote mic and abort.
      this.#writeMicClose();
      this.reset();
      this.#hooks.onStatus({ sessionRejected: reason });
      return;
    }
    if (this.phase === 'holding') {
      // Keep the gesture alive; audio is discarded until key release.
      this.#sessionMode = null;
      this.#hooks.onStatus({ sessionRejected: reason });
    }
  }

  hostSessionEnded() {
    this.#log(`host ended session (phase=${this.phase})`);
    if (this.phase === 'persistent') {
      this.#writeMicClose();
      this.reset();
    } else if (this.phase === 'holding') {
      this.#sessionMode = null; // wait for key release, then idle
    }
  }

  #audioStart(event) {
    this.#streamActive = true;
    this.#streamId = event.streamId ?? 0;
    this.#decoder.beginStream();
    this.#startKeepAlive();
    this.#log(`audio_start reason=0x${event.reason.toString(16)} streamId=${this.#streamId} phase=${this.phase}`);

    if (event.reason === ATVV_REASON_PHYSICAL_START) {
      if (this.phase === 'pressing' || this.phase === 'holding') return; // duplicate
      if (this.phase === 'persistent') {
        // A physical press interrupts the persistent stream. Keep the session
        // running; on release the session closes regardless of duration. The
        // physical stream supersedes any pending MIC_OPEN confirmation retry.
        if (this.#micOpenTimer) {
          this.#clock.clearTimer(this.#micOpenTimer);
          this.#micOpenTimer = null;
        }
        this.#gesture = { startedAt: this.#clock.now(), sessionWasActive: true };
        this.#hooks.onStatus({ phase: 'persistent-physical' });
        return;
      }
      // idle: fresh gesture. The mode decides what the key means — no
      // duration interpretation in either mode.
      this.#gesture = { startedAt: this.#clock.now(), sessionWasActive: false };
      if (this.#config.voiceMode === 'hold') {
        // 长按模式：语音键即 PTT —— 按下立即开会话，音频经 host 会话的
        // 预接受缓冲补发，抬起结束。
        this.phase = 'holding';
        this.#sessionMode = 'ptt';
        this.#log('key down -> ptt session');
        this.#hooks.startSession('ptt', 'hold', new Int16Array(0));
        this.#hooks.onStatus({ phase: 'holding' });
        return;
      }
      // 短按模式：按住期间只缓存音频；抬起那一刻才是切换动作。
      this.phase = 'pressing';
      this.#hooks.onStatus({ phase: 'pressing' });
      return;
    }

    // Host-initiated stream: confirmation of a MIC_OPEN, or a stale response.
    if (this.phase === 'persistent') {
      this.#hostStreamConfirmed = true;
      this.#micOpenAttempts = 0;
      if (this.#micOpenTimer) {
        this.#clock.clearTimer(this.#micOpenTimer);
        this.#micOpenTimer = null;
      }
      this.#hooks.onStatus({ phase: 'persistent', streamId: this.#streamId });
      return;
    }
    if (this.phase === 'idle') {
      // Stale host stream while no session wants it: clean it up idempotently.
      this.#writeMicClose();
    }
  }

  #audioStop(event) {
    this.#streamActive = false;
    this.#stopKeepAlive();
    this.#log(`audio_stop reason=0x${event.reason.toString(16)} phase=${this.phase} gesture=${this.#gesture ? 'yes' : 'no'}`);

    if (event.reason === ATVV_REASON_PHYSICAL_STOP && this.#gesture) {
      const gesture = this.#gesture;
      this.#gesture = null;
      const duration = this.#clock.now() - gesture.startedAt;

      // 短按模式：按下-抬起 = 切换录音开关（开）。
      if (this.#config.voiceMode === 'tap' && this.phase === 'pressing' && !gesture.sessionWasActive) {
        this.#log(`toggle press (${duration.toFixed(0)} ms) -> opening persistent stream`);
        this.#convertTapToPersistent();
        return;
      }

      // 其余松开一律结束会话：长按模式的抬起（ptt 结束，快速点按只是很短
      // 的一次会话）；短按模式会话进行中的按下-抬起（切换关）。
      if (this.#sessionMode !== null) {
        this.#log(`closing session at release (duration=${duration.toFixed(0)} ms)`);
        this.#hooks.stopSession('device');
      }
      this.#writeMicClose();
      this.reset();
      this.#hooks.onStatus({ phase: 'idle', lastGesture: gesture.sessionWasActive ? 'toggle-off' : 'hold' });
      return;
    }

    // Non-physical stop: the persistent/hold stream ended on its own (or our
    // own MIC_CLOSE took effect — the session path already reset to idle).
    if (this.phase === 'persistent') {
      if (event.reason === ATVV_REASON_PHYSICAL_STOP && !this.#gesture) {
        // Duplicate/stray release notification (BLE retransmit) after the tap
        // conversion: the finger is not on the key and the session is
        // host-owned, so ignore it instead of tearing the session down.
        this.#log('ignoring stray physical release while persistent');
        this.#streamActive = true; // treat the stream as still alive
        this.#startKeepAlive();
        return;
      }
      if (this.#micOpenTimer) {
        // Retry pending: this stop belongs to a failed MIC_OPEN attempt.
        this.#log('audio_stop during mic-open retry window');
        return;
      }
      this.#log(`persistent stream ended (reason=0x${event.reason.toString(16)}) -> closing session`);
      if (this.#sessionMode !== null) this.#hooks.stopSession('device');
      this.#writeMicClose();
      this.reset();
      this.#hooks.onStatus({ phase: 'idle' });
      return;
    }
    if (this.phase === 'holding' || this.phase === 'pressing') {
      // Physical stream aborted without a release event.
      this.#log(`stream aborted without release (phase=${this.phase})`);
      this.#clearGestureTimers();
      if (this.#sessionMode !== null) this.#hooks.stopSession('device');
      this.reset();
      this.#hooks.onStatus({ phase: 'idle', aborted: true });
    }
  }

  #convertTapToPersistent() {
    this.phase = 'persistent';
    this.#sessionMode = 'handsfree-ptt';
    this.#hostStreamConfirmed = false;
    this.#micOpenAttempts = 1;
    // Decoder state must be clean before MIC_OPEN; ATVV may deliver AUDIO_SYNC
    // before or after AUDIO_START and a stale state would corrupt the stream.
    this.#decoder.reset();
    const initial = this.#gestureBuffer.drain();
    this.#hooks.startSession('handsfree-ptt', 'tap', initial);
    this.#log('mic_open attempt 1');
    this.#writeMicOpen();
    this.#armMicOpenConfirm();
    this.#hooks.onStatus({ phase: 'persistent' });
  }

  #armMicOpenConfirm() {
    if (this.#micOpenTimer) this.#clock.clearTimer(this.#micOpenTimer);
    this.#micOpenTimer = this.#clock.setTimer(() => {
      this.#micOpenTimer = null;
      if (this.phase !== 'persistent' || this.#hostStreamConfirmed) return;
      if (this.#micOpenAttempts >= MIC_OPEN_MAX_ATTEMPTS) {
        this.#log(`mic_open give up after ${this.#micOpenAttempts} attempts -> cancel session`);
        if (this.#sessionMode !== null) this.#hooks.stopSession('mic_open_failed', { cancel: true });
        this.#writeMicClose();
        this.reset();
        this.#hooks.onStatus({ phase: 'idle', micOpenFailed: true });
        return;
      }
      this.#micOpenAttempts += 1;
      this.#log(`mic_open attempt ${this.#micOpenAttempts}`);
      this.#writeMicOpen();
      this.#armMicOpenConfirm();
    }, MIC_OPEN_CONFIRM_TIMEOUT_MS);
  }

  #micOpenFailed(cause) {
    if (this.phase !== 'persistent' || this.#hostStreamConfirmed) return;
    // The confirm timer owns retry pacing (~1 s spacing, mirroring vRemoter's
    // open-confirmation loop): an error response must not exhaust the retries
    // within milliseconds. Arm the timer only if none is pending.
    this.#log(`mic_open error: ${cause}`);
    if (!this.#micOpenTimer) this.#armMicOpenConfirm();
    this.#hooks.onStatus({ phase: 'persistent', micOpenError: cause });
  }

  #writeMicOpen() {
    if (!this.atvv) return;
    this.#hooks.writeDevice(micOpenCommand(this.atvv.version, this.atvv.codec));
  }

  #log(message) {
    // Worker stderr; the Host surfaces it in its log view. Cheap enough to
    // keep on every device-state transition for field diagnosis.
    console.error(`[cast-atvv] ${message}`);
  }

  #writeMicClose() {
    if (!this.atvv) return;
    this.#hooks.writeDevice(micCloseCommand(this.atvv.version, this.#streamId));
  }

  #startKeepAlive() {
    this.#stopKeepAlive();
    this.#keepAliveTimer = this.#clock.setTimer(() => {
      if (!this.#streamActive || !this.atvv) return;
      this.#hooks.writeDevice(keepAliveCommand(this.atvv.version, this.#streamId, this.atvv.codec));
      this.#startKeepAlive(); // re-arm while streaming
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  #stopKeepAlive() {
    if (this.#keepAliveTimer) {
      this.#clock.clearTimer(this.#keepAliveTimer);
      this.#keepAliveTimer = null;
    }
  }

  #clearGestureTimers() {
    if (this.#micOpenTimer) {
      this.#clock.clearTimer(this.#micOpenTimer);
      this.#micOpenTimer = null;
    }
    this.#stopKeepAlive();
  }

  #resample(samples) {
    return this.atvv && codecSampleRate(this.atvv.codec) === 8000 ? upsampleX2(samples) : samples;
  }
}
