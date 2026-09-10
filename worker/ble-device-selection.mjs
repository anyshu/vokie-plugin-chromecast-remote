// ATVV is shared by several vendors. A service/cache hit is not a model ID.
const CHROMECAST_NAMES = new Set(['chromecast remote', 'chromecast voice remote']);

export function isChromecastCandidate(device) {
  return typeof device?.deviceId === 'string' && device.deviceId.trim().length > 0 &&
    typeof device.name === 'string' && CHROMECAST_NAMES.has(device.name.trim().toLowerCase());
}

export function pickChromecastCandidate(devices, failedUntil, now) {
  const seen = new Set();
  for (const device of Array.isArray(devices) ? devices : []) {
    if (!isChromecastCandidate(device) || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    if ((failedUntil.get(device.deviceId) ?? 0) > now) continue;
    return device; // preserve opaque deviceId and original name
  }
  return null;
}
