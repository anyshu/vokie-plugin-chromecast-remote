// Plugin-owned IOKit HID helper process (macOS).
//
// `assets/chromecast-hid-helper` is a self-contained Swift binary that matches
// the Chromecast Voice Remote (18D1:9450) through IOKit — the same mechanism
// vRemoter uses — and streams input reports as JSON lines:
//
//   {"type":"hid_report","data":"<base64, report ID included>"}
//   {"type":"device","connected":true|false}
//   {"type":"started","seize":true}
//   {"type":"error","message":"..."}
//
// IOKit only sees the remote while it is paired through the macOS Bluetooth
// HID stack; in that configuration the HID-over-GATT service is claimed by
// the OS (our GATT subscription gets `not_found`), so this helper is the
// reliable button source. The helper exits by itself on SIGTERM or stdin EOF,
// so it never outlives the worker.

import { spawn } from 'node:child_process';
import { access, chmod, constants } from 'node:fs/promises';

const MAX_RESTARTS = 3;
const RESTART_BASE_DELAY_MS = 1000;

/** Release a child's stdio sockets so they cannot hold the event loop. */
function destroyStreams(child) {
  try { child.stdin?.end(); } catch { /* already closed */ }
  try { child.stdout?.destroy(); } catch { /* already closed */ }
  try { child.stderr?.destroy(); } catch { /* already closed */ }
}

export class HidHelperSource {
  /**
   * @param {object} options
   * @param {string} options.helperPath absolute path to the helper binary
   * @param {() => string[]} options.buildArgs CLI arguments for the current config
   * @param {(bytes: Uint8Array) => void} options.onReport raw HID report (report ID included)
   * @param {(info: {running: boolean, error?: string}) => void} options.onStatus
   * @param {(message: object) => void} [options.onInfo] helper lifecycle lines
   *        ({"type":"started","seize":false} / {"type":"device","connected":true} / …)
   * @param {object} [options.clock] injectable {setTimer(fn, ms), clearTimer(handle)}
   */
  constructor({ helperPath, buildArgs, onReport, onStatus, onInfo, clock } = {}) {
    if (typeof helperPath !== 'string' || !helperPath) throw new Error('helperPath is required');
    this.#helperPath = helperPath;
    this.#buildArgs = buildArgs ?? (() => []);
    this.#onReport = onReport ?? (() => {});
    this.#onStatus = onStatus ?? (() => {});
    this.#onInfo = onInfo ?? (() => {});
    this.#clock = clock ?? {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle)
    };
    this.#child = null;
    this.#stopped = true;
    this.#restarts = 0;
    this.#lineBuffer = '';
    this.#restartTimer = null;
  }

  #helperPath;
  #buildArgs;
  #onReport;
  #onStatus;
  #onInfo;
  #clock;
  #child;
  #stopped;
  #restarts;
  #lineBuffer;
  #restartTimer;

  get running() {
    return this.#child !== null && this.#child.exitCode === null;
  }

  async start() {
    if (!this.#stopped || this.#child) return;
    this.#stopped = false;
    this.#restarts = 0;
    await this.#spawn();
  }

  stop() {
    this.#stopped = true;
    if (this.#restartTimer) {
      this.#clock.clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#child) {
      const child = this.#child;
      this.#child = null;
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
      // The parent owns the pipe write ends; without an explicit destroy the
      // socket handles keep the worker's event loop alive after the kill.
      destroyStreams(child);
    }
    this.#lineBuffer = '';
  }

  async #spawn() {
    const executable = await this.#ensureExecutable();
    if (!executable || this.#stopped) return;

    const child = spawn(this.#helperPath, this.#buildArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#lineBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (chunk.trim()) console.error('[chromecast-remote] hid helper:', chunk.trim());
    });
    child.on('error', (error) => {
      destroyStreams(child);
      this.#reportSpawnFailure(`无法启动 HID 助手：${error.message}`);
    });
    child.on('exit', (code, signal) => {
      destroyStreams(child);
      if (this.#child === child) this.#child = null;
      if (this.#stopped) return;
      // Unexpected exit: bounded respawn, then give up for this run.
      this.#restarts += 1;
      if (this.#restarts > MAX_RESTARTS) {
        this.#onStatus({ running: false, error: `HID 助手多次退出（code=${code} signal=${signal}），已停用` });
        this.#stopped = true;
        return;
      }
      const delay = RESTART_BASE_DELAY_MS * this.#restarts;
      this.#restartTimer = this.#clock.setTimer(() => {
        this.#restartTimer = null;
        if (!this.#stopped) void this.#spawn();
      }, delay);
    });
    this.#onStatus({ running: true });
  }

  async #ensureExecutable() {
    try {
      await access(this.#helperPath, constants.X_OK);
      return true;
    } catch {
      // The installer may not preserve the executable bit; the helper is our
      // own bundled file, so repair the mode once before giving up.
      try {
        await chmod(this.#helperPath, 0o755);
        await access(this.#helperPath, constants.X_OK);
        return true;
      } catch (error) {
        this.#reportSpawnFailure(`HID 助手不可执行（${this.#helperPath}）：${error.message}`);
        return false;
      }
    }
  }

  #reportSpawnFailure(message) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#onStatus({ running: false, error: message });
  }

  #consume(chunk) {
    this.#lineBuffer += chunk;
    for (;;) {
      const newline = this.#lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#lineBuffer.slice(0, newline).trim();
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.type === 'hid_report' && typeof message.data === 'string') {
        try {
          this.#onReport(new Uint8Array(Buffer.from(message.data, 'base64')));
        } catch {
          // malformed base64; ignore the frame
        }
        continue;
      }
      // started / device / error lines: surface them (e.g. the seize fallback
      // note) while the exit callback and stderr cover hard failures.
      if (message?.type && message.type !== 'hid_report') {
        try {
          this.#onInfo(message);
        } catch {
          // listener errors must not kill the pump
        }
      }
    }
  }
}
