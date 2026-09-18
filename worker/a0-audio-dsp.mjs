import { A0PeakLimiter } from './a0-peak-limiter.mjs';

const SAMPLE_RATE = 16000;
const TARGET_RMS = decibelsToAmplitude(-28);
const COMPRESSOR_TARGET_RMS = decibelsToAmplitude(-23);
const VOICE_FLOOR_RMS = decibelsToAmplitude(-50);
const INITIAL_GAIN = decibelsToAmplitude(3);
const OUTPUT_GAIN = decibelsToAmplitude(3);
const MIN_LEVEL_GAIN = 1;
const MAX_GAIN = decibelsToAmplitude(15);
const MIN_COMPRESSOR_GAIN = decibelsToAmplitude(-15);
const DETECTOR_POWER_CEILING = decibelsToAmplitude(-12) ** 2;
const SILENCE_HOLD_SAMPLES = Math.round(SAMPLE_RATE * 0.1);
const LEVEL_WINDOW_SAMPLES = Math.round(SAMPLE_RATE * 0.02);

const ACTIVITY_ATTACK = smoothingCoefficient(0.01);
const ACTIVITY_RELEASE = smoothingCoefficient(0.04);
const GAIN_REDUCTION = smoothingCoefficient(0.06);
const GAIN_INCREASE = smoothingCoefficient(0.05);
const SILENCE_RETURN = smoothingCoefficient(0.08);
const COMPRESSOR_LEVEL_ATTACK = smoothingCoefficient(0.005);
const COMPRESSOR_LEVEL_RELEASE = smoothingCoefficient(0.03);
const COMPRESSOR_GAIN_ATTACK = smoothingCoefficient(0.002);
const COMPRESSOR_GAIN_RELEASE = smoothingCoefficient(0.03);

class Biquad {
  #coefficients;
  #z1 = 0;
  #z2 = 0;

  constructor(coefficients) {
    this.#coefficients = coefficients;
  }

  reset() {
    this.#z1 = 0;
    this.#z2 = 0;
  }

  process(input) {
    const { b0, b1, b2, a1, a2 } = this.#coefficients;
    const output = b0 * input + this.#z1;
    this.#z1 = b1 * input - a1 * output + this.#z2;
    this.#z2 = b2 * input - a2 * output;
    return output;
  }
}

/** A0-specific real-time leveler, independent of the V1-tuned denoising and EQ. */
export class GoogleTvA0AudioDsp {
  #peakLimiter = new A0PeakLimiter();
  #highPass = new Biquad(
    createHighPassCoefficients(100, SAMPLE_RATE, Math.SQRT1_2)
  );
  // A bounded RMS window drops a loud syllable after 20 ms, instead of letting
  // its exponentially decaying energy suppress the next quiet syllable.
  #levelPowers = new Float64Array(LEVEL_WINDOW_SAMPLES);
  #levelPowerSum = 0;
  #levelPosition = 0;
  #levelSamples = 0;
  #activityPower = 0;
  #gain = INITIAL_GAIN;
  #compressorPower = 0;
  #compressorGain = 1;
  #silentSamples = 0;

  reset() {
    this.#peakLimiter.reset();
    this.#highPass.reset();
    this.#levelPowers.fill(0);
    this.#levelPowerSum = 0;
    this.#levelPosition = 0;
    this.#levelSamples = 0;
    this.#activityPower = 0;
    this.#gain = INITIAL_GAIN;
    this.#compressorPower = 0;
    this.#compressorGain = 1;
    this.#silentSamples = 0;
  }

  process(input) {
    const output = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const filtered = this.#highPass.process(input[index] / 32768);
      const power = filtered * filtered;
      const detectorPower = Math.min(power, DETECTOR_POWER_CEILING);
      this.#levelPowerSum +=
        detectorPower - this.#levelPowers[this.#levelPosition];
      this.#levelPowers[this.#levelPosition] = detectorPower;
      this.#levelPosition = (this.#levelPosition + 1) % LEVEL_WINDOW_SAMPLES;
      this.#levelSamples = Math.min(
        this.#levelSamples + 1,
        LEVEL_WINDOW_SAMPLES
      );
      this.#activityPower = smoothPower(
        this.#activityPower,
        power,
        ACTIVITY_ATTACK,
        ACTIVITY_RELEASE
      );

      if (Math.sqrt(this.#activityPower) >= VOICE_FLOOR_RMS) {
        this.#silentSamples = 0;
        const level = Math.max(
          Math.sqrt(Math.max(0, this.#levelPowerSum) / this.#levelSamples),
          VOICE_FLOOR_RMS
        );
        const targetGain = clamp(
          TARGET_RMS / level,
          MIN_LEVEL_GAIN,
          MAX_GAIN
        );
        const coefficient =
          targetGain < this.#gain ? GAIN_REDUCTION : GAIN_INCREASE;
        this.#gain = targetGain + coefficient * (this.#gain - targetGain);
      } else {
        this.#silentSamples += 1;
        if (this.#silentSamples > SILENCE_HOLD_SAMPLES) {
          this.#gain =
            INITIAL_GAIN + SILENCE_RETURN * (this.#gain - INITIAL_GAIN);
        }
      }

      const amplified = filtered * this.#gain;
      this.#compressorPower = smoothPower(
        this.#compressorPower,
        amplified * amplified,
        COMPRESSOR_LEVEL_ATTACK,
        COMPRESSOR_LEVEL_RELEASE
      );
      const compressorLevel = Math.sqrt(this.#compressorPower);
      const targetCompressorGain = clamp(
        COMPRESSOR_TARGET_RMS /
          Math.max(compressorLevel, COMPRESSOR_TARGET_RMS),
        MIN_COMPRESSOR_GAIN,
        1
      );
      const compressorCoefficient =
        targetCompressorGain < this.#compressorGain
          ? COMPRESSOR_GAIN_ATTACK
          : COMPRESSOR_GAIN_RELEASE;
      this.#compressorGain =
        targetCompressorGain +
        compressorCoefficient *
          (this.#compressorGain - targetCompressorGain);
      output[index] = Math.round(
        this.#peakLimiter.process(
          amplified * this.#compressorGain * OUTPUT_GAIN
        ) * 32767
      );
    }
    return output;
  }

  flush() {
    this.reset();
    return new Int16Array();
  }
}

function smoothPower(current, next, attack, release) {
  const coefficient = next > current ? attack : release;
  return next + coefficient * (current - next);
}

function smoothingCoefficient(seconds) {
  return Math.exp(-1 / (SAMPLE_RATE * seconds));
}

function decibelsToAmplitude(decibels) {
  return 10 ** (decibels / 20);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createHighPassCoefficients(frequency, sampleRate, q) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cosine = Math.cos(omega);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosine) / 2 / a0,
    b1: -(1 + cosine) / a0,
    b2: (1 + cosine) / 2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0
  };
}
