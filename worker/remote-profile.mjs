// Ported from xiguashuo-pc GoogleTvRemoteProfile.swift (40ba1c2f).
export function remoteProfile(modelNumber) {
  return String(modelNumber ?? '').trim() === 'A0' ? 'a0' : 'legacy';
}

export function buttonReport(profile, { gattHandle, value }) {
  if (!Array.isArray(value)) return null;
  if (profile === 'a0') {
    if (gattHandle !== 0x29 || value.length !== 8 || value.slice(1).some(byte => byte !== 0)) return null;
    return ({ 7: 'select', 11: 'back', 0: 'released' })[value[0]] ?? null;
  }
  if (gattHandle !== 0x2b || value.length !== 2) return null;
  if (value[0] === 0x41 && value[1] === 0) return 'select';
  if (value[0] === 0x24 && value[1] === 2) return 'back';
  return value.every(byte => byte === 0) ? 'released' : null;
}

export function matchesHciSource(source, address) {
  if (['chromecast remote', 'chromecast voice remote'].includes(source.toLowerCase())) return true;
  const normalize = value => String(value ?? '').replaceAll('-', ':').toLowerCase();
  const target = normalize(address);
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(target) &&
    target !== '00:00:00:00:00:00' && normalize(source) === target;
}
