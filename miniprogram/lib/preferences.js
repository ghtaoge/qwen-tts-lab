const KEY = 'qwenPreferences';
const DEFAULTS = {
  selectedVoice: 'Serena', speed: 1, displayMode: 'buddy',
  useCache: true, autoPlayParts: false, sendDevice: true
};
const VOICES = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric'];
const MODES = ['buddy', 'wave', 'text'];

function validate(value, base) {
  // Retire the old first-fragment setting, including previously saved true values.
  const result = Object.assign({}, base || DEFAULTS, {autoPlayParts: false});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (VOICES.includes(value.selectedVoice)) result.selectedVoice = value.selectedVoice;
  if (typeof value.speed === 'number' && Number.isFinite(value.speed) && value.speed >= .75 && value.speed <= 1.5) {
    result.speed = Math.round(value.speed * 100) / 100;
  }
  if (MODES.includes(value.displayMode)) result.displayMode = value.displayMode;
  for (const key of ['useCache', 'sendDevice']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return result;
}

function get() {
  try { return validate(wx.getStorageSync(KEY)); }
  catch (_) { return validate(null); }
}

function save(patch) {
  const value = validate(patch, get());
  wx.setStorageSync(KEY, value);
  return Object.assign({}, value);
}

module.exports = {get, save};
