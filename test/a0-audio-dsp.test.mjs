import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleTvA0AudioDsp } from '../worker/a0-audio-dsp.mjs';
import { A0PeakLimiter } from '../worker/a0-peak-limiter.mjs';

function tone(amplitude, count = 16000) {
  return Int16Array.from({ length: count }, (_, index) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * 1000 * index) / 16000))
  );
}

function concatenate(...parts) {
  return Int16Array.from(parts.flatMap((part) => [...part]));
}

function processComplete(input, chunkSize = input.length || 1) {
  const dsp = new GoogleTvA0AudioDsp();
  const output = [];
  for (let index = 0; index < input.length; index += chunkSize) {
    output.push(...dsp.process(input.subarray(index, index + chunkSize)));
  }
  output.push(...dsp.flush());
  return Int16Array.from(output);
}

function rms(input) {
  return Math.sqrt(
    input.reduce((sum, sample) => sum + sample * sample, 0) / input.length
  );
}

function relativeDb(left, right) {
  return 20 * Math.log10(rms(left) / rms(right));
}

test('A0 peak guard preserves speech, catches immediate spikes and resets', () => {
  const limiter = new A0PeakLimiter();
  assert.equal(limiter.process(0.1), 0.1);
  assert.equal(limiter.process(-0.2), -0.2);
  for (const sample of [3, -5, 2, -0.9]) {
    assert.ok(Math.abs(limiter.process(sample)) <= 10 ** (-6 / 20));
  }
  let recovered = 0;
  for (let index = 0; index < 640; index += 1) {
    recovered = limiter.process(0.1);
  }
  assert.ok(20 * Math.log10(recovered / 0.1) > -0.1);
  limiter.process(5);
  limiter.reset();
  assert.equal(limiter.process(0.1), 0.1);
});

test('A0 DSP levels sustained quiet and loud speech without changing sample count', () => {
  const input = concatenate(tone(800), tone(8000), tone(800));
  const output = processComplete(input, 320);
  assert.equal(output.length, input.length);

  const quietBefore = output.subarray(8000, 16000);
  const loud = output.subarray(24000, 32000);
  const quietAfter = output.subarray(40000, 48000);
  assert.ok(Math.abs(relativeDb(loud, quietBefore)) < 4.5);
  assert.ok(Math.abs(relativeDb(quietAfter, quietBefore)) < 4.5);
});

test('A0 DSP ignores sub-floor noise and recovers after a transient peak', () => {
  const noise = tone(40, 32000);
  const noiseOutput = processComplete(noise, 160);
  assert.ok(relativeDb(noiseOutput, noise) < 6.1);

  const transientInput = concatenate(
    tone(1200, 16000),
    Int16Array.from([32767, -32768]),
    tone(1200, 16000)
  );
  const transient = processComplete(transientInput, 320);
  assert.ok(Math.max(...transient.map(Math.abs)) <= 16423);
  const before = transient.subarray(12000, 16000);
  const after = transient.subarray(18000, 22000);
  assert.ok(Math.abs(relativeDb(after, before)) < 0.75);
});

test('A0 DSP returns toward baseline in pauses without bursting', () => {
  const quiet = tone(400, 16000);
  const pause = tone(40, 11200);
  const loud = tone(4000, 16000);
  const output = processComplete(concatenate(quiet, pause, loud), 160);

  const pauseInputTail = pause.subarray(pause.length - 3200);
  const pauseOutputTail = output.subarray(24000, 27200);
  assert.ok(relativeDb(pauseOutputTail, pauseInputTail) < 7);

  const loudStart = output.subarray(27200, 28800);
  const loudSteady = output.subarray(35200, 40000);
  assert.ok(relativeDb(loudStart, loudSteady) < 3);
});

test('A0 DSP is packet-boundary independent and reset restores initial state', () => {
  const input = concatenate(tone(900, 12000), tone(7000, 12000));
  const whole = processComplete(input);
  assert.deepEqual(processComplete(input, 160), whole);
  assert.deepEqual(processComplete(input, 320), whole);

  const dsp = new GoogleTvA0AudioDsp();
  dsp.process(tone(12000));
  dsp.reset();
  assert.deepEqual(concatenate(dsp.process(input), dsp.flush()), whole);
});

test('A0 DSP preserves digital silence', () => {
  assert.deepEqual(
    processComplete(new Int16Array(16000)),
    new Int16Array(16000)
  );
});

test('A0 DSP raises weak short syllables without sustained-tone delay', () => {
  const quiet = tone(330, 4800);
  const loud = tone(3300, 4800);
  const output = processComplete(concatenate(quiet, loud, quiet), 320);
  const quietBefore = output.subarray(1600, 4800);
  const loudMiddle = output.subarray(6400, 9600);
  const quietAfter = output.subarray(11200, 14400);
  assert.ok(relativeDb(quietBefore, quiet.subarray(1600)) > 13);
  assert.ok(Math.abs(relativeDb(loudMiddle, quietBefore)) < 3);
  assert.ok(Math.abs(relativeDb(quietAfter, quietBefore)) < 1.5);
});
