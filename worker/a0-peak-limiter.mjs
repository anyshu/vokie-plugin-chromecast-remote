const PEAK_CEILING = 10 ** (-6 / 20);
const RELEASE = Math.exp(-1 / (16000 * 0.008));

/** A0 final peak guard; leaves headroom for resampling and lossy Opus coding. */
export class A0PeakLimiter {
  #gain = 1;

  reset() {
    this.#gain = 1;
  }

  process(sample) {
    const target = Math.min(
      1,
      PEAK_CEILING / Math.max(Math.abs(sample), PEAK_CEILING)
    );
    // No attack delay: the first transient sample must also respect the ceiling.
    // Release over a few cycles instead of independently saturating each sample.
    this.#gain =
      target < this.#gain ? target : target + RELEASE * (this.#gain - target);
    return sample * this.#gain;
  }
}
