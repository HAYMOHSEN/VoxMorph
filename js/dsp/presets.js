// VoxMorph DSP — voice presets and settings resolution.
//
// A preset describes the *target* voice. In auto mode the pitch shift is computed from the
// speaker's measured pitch (so a man and a woman both end up sounding like the same kind of
// child), otherwise a fixed semitone offset is used. Formant ratios are relative to an adult
// male vocal tract; for higher-pitched speakers they are scaled down accordingly.

export const PRESET_IDS = ['child', 'woman', 'oldman', 'broadcaster', 'enhance', 'custom'];

export const PRESETS = {
  child:       { targetF0: 250, formant: 1.28, semis: 9,  breath: 0.12, brightness: 2,   warmth: 0, tremor: 0,   rough: 0,    radio: false, compress: 0.35 },
  woman:       { targetF0: 205, formant: 1.17, semis: 5,  breath: 0.10, brightness: 1,   warmth: 0, tremor: 0,   rough: 0,    radio: false, compress: 0.35 },
  oldman:      { targetF0: 108, formant: 0.97, semis: -2, breath: 0.16, brightness: -3,  warmth: 0, tremor: 0.8, rough: 0.12, radio: false, compress: 0.35 },
  broadcaster: { targetF0: 96,  formant: 0.94, semis: -3, breath: 0,    brightness: 1.5, warmth: 3, tremor: 0,   rough: 0,    radio: true,  compress: 0.85 },
  enhance:     { targetF0: null, formant: 1,   semis: 0,  breath: 0,    brightness: 1.5, warmth: 2, tremor: 0,   rough: 0,    radio: true,  compress: 0.65 },
  custom:      { targetF0: null, formant: 1,   semis: 0,  breath: 0,    brightness: 0,   warmth: 0, tremor: 0,   rough: 0,    radio: false, compress: 0.3 },
};

// Typical female/male ratios used to re-reference presets for higher-pitched speakers
const FEMALE_F0_SPLIT = 165;     // Hz — above this the speaker is treated as a higher voice
const FEMALE_FORMANT_REF = 1.16;

export function defaultSettings() {
  return {
    preset: 'broadcaster',
    intensity: 1,
    auto: true,
    pitchOffset: 0,        // semitones added on top of the preset
    formantOffset: 0,      // percent added on top of the preset
    breath: null, tremor: null, rough: null, brightness: null, warmth: null, radio: null, compress: null,
    nr: { enabled: true, strength: 0.6 },
    gate: { enabled: false, thresholdDb: -48 },
    normalize: { enabled: true, targetLufs: -16 },
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (override, base) => (override === null || override === undefined ? base : override);

/**
 * Turn user settings (+ measured voice info) into concrete DSP parameters.
 * @param {object} settings  see defaultSettings()
 * @param {object|null} voiceInfo  { f0Median, voicedRatio } from analysis, or null
 */
export function resolveSettings(settings, voiceInfo) {
  const base = PRESETS[settings.preset] || PRESETS.custom;
  const s = clamp(settings.intensity ?? 1, 0.25, 1.5);
  let semis = base.semis;
  let formant = base.formant;
  let autoUsed = false;
  const f0 = voiceInfo && voiceInfo.f0Median > 0 && (voiceInfo.voicedRatio ?? 1) > 0.05 ? voiceInfo.f0Median : 0;
  if (settings.auto && f0 && base.targetF0) {
    semis = 12 * Math.log2(base.targetF0 / f0);
    if (f0 > FEMALE_F0_SPLIT) formant = base.formant / FEMALE_FORMANT_REF;
    autoUsed = true;
    // Speaker already matches the target class: still make it a clearly different voice
    if (Math.abs(semis) < 1.5 && Math.abs(formant - 1) < 0.06) {
      if (base.targetF0 >= 180) { semis += 3; formant *= 1.05; }
      else { semis -= 2; formant *= 0.96; }
    }
  }
  // Intensity scales the deviation from the original voice
  semis *= s;
  formant = Math.pow(formant, s);
  // Fine adjustments
  semis += settings.pitchOffset || 0;
  formant *= 1 + (settings.formantOffset || 0) / 100;
  semis = clamp(semis, -24, 24);
  const pitchRatio = clamp(Math.pow(2, semis / 12), 0.45, 2.4);
  const formantRatio = clamp(formant, 0.6, 1.7);

  return {
    pitchRatio,
    formantRatio,
    semitones: 12 * Math.log2(pitchRatio),
    autoUsed,
    breath: clamp(pick(settings.breath, base.breath * s), 0, 1.5),
    tremor: clamp(pick(settings.tremor, base.tremor * s), 0, 1.5),
    rough: clamp(pick(settings.rough, base.rough * s), 0, 1),
    brightness: clamp(pick(settings.brightness, base.brightness * s), -8, 8),
    warmth: clamp(pick(settings.warmth, base.warmth * s), -8, 8),
    radio: !!pick(settings.radio, base.radio),
    compress: clamp(pick(settings.compress, base.compress), 0, 1),
    nr: { enabled: !!(settings.nr && settings.nr.enabled), strength: clamp(settings.nr ? settings.nr.strength : 0.6, 0, 1) },
    gate: { enabled: !!(settings.gate && settings.gate.enabled), thresholdDb: settings.gate ? settings.gate.thresholdDb : -48 },
    normalize: { enabled: !!(settings.normalize && settings.normalize.enabled), targetLufs: settings.normalize ? settings.normalize.targetLufs : -16 },
  };
}
