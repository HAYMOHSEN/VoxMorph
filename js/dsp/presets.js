// VoxMorph DSP — voice presets (grouped in categories) and settings resolution.
//
// A preset describes the *target* voice. In auto mode the pitch shift is computed from the
// speaker's measured pitch (so a man and a woman both end up sounding like the same kind of
// child), otherwise a fixed semitone offset is used. Formant ratios are relative to an adult
// male vocal tract; for higher-pitched speakers they are scaled down accordingly.
//
// Fields: targetF0 (Hz, null = keep), formant (ratio), semis (fixed-mode offset), breath, tremor,
// rough, brightness (dB), warmth (dB), radio (bool), compress (0..1), ringMod (0..1, robot voice).

export const CATEGORIES = ['child', 'woman', 'man', 'fx', 'other'];

const P = (cat, o) => Object.assign({ category: cat, targetF0: null, formant: 1, semis: 0, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, radio: false, compress: 0.35, ringMod: 0, ringHz: 0 }, o);

export const PRESETS = {
  // ---- child ------------------------------------------------------------------------
  child_young:  P('child', { targetF0: 300, formant: 1.36, semis: 12, breath: 0.15, brightness: 2.5 }),
  child:        P('child', { targetF0: 250, formant: 1.28, semis: 9,  breath: 0.12, brightness: 2 }),
  child_girl:   P('child', { targetF0: 275, formant: 1.32, semis: 10, breath: 0.14, brightness: 2 }),
  teen_boy:     P('child', { targetF0: 150, formant: 1.08, semis: 4,  breath: 0.05, rough: 0.08, brightness: 1 }),
  // ---- woman ------------------------------------------------------------------------
  woman:        P('woman', { targetF0: 205, formant: 1.17, semis: 5,  breath: 0.10, brightness: 1 }),
  woman_young:  P('woman', { targetF0: 235, formant: 1.20, semis: 7,  breath: 0.12, brightness: 2 }),
  woman_anchor: P('woman', { targetF0: 185, formant: 1.13, semis: 4,  breath: 0.04, brightness: 1, warmth: 2, radio: true, compress: 0.75 }),
  woman_soft:   P('woman', { targetF0: 205, formant: 1.17, semis: 5,  breath: 0.40, brightness: -1, warmth: 1, compress: 0.55 }),
  woman_elder:  P('woman', { targetF0: 180, formant: 1.12, semis: 3,  breath: 0.20, tremor: 0.7, rough: 0.08, brightness: -2.5 }),
  // ---- man --------------------------------------------------------------------------
  broadcaster:  P('man',   { targetF0: 96,  formant: 0.94, semis: -3, brightness: 1.5, warmth: 3, radio: true, compress: 0.85 }),
  man_narrator: P('man',   { targetF0: 105, formant: 0.96, semis: -2, breath: 0.12, brightness: 1, warmth: 3, compress: 0.6 }),
  man_young:    P('man',   { targetF0: 135, formant: 1.03, semis: 2,  breath: 0.05, brightness: 1.5, compress: 0.4 }),
  man_deep:     P('man',   { targetF0: 85,  formant: 0.88, semis: -5, rough: 0.05, warmth: 4, compress: 0.6 }),
  oldman:       P('man',   { targetF0: 108, formant: 0.97, semis: -2, breath: 0.16, tremor: 0.8, rough: 0.12, brightness: -3 }),
  // ---- effects ----------------------------------------------------------------------
  fx_robot:     P('fx',    { targetF0: 110, formant: 1.0,  semis: -1, ringMod: 0.85, ringHz: 45, brightness: -3, compress: 0.7 }),
  fx_giant:     P('fx',    { targetF0: 70,  formant: 0.80, semis: -8, rough: 0.15, warmth: 4, compress: 0.5 }),
  fx_cartoon:   P('fx',    { targetF0: 380, formant: 1.45, semis: 16, brightness: 3, compress: 0.4 }),
  // ---- other ------------------------------------------------------------------------
  enhance:      P('other', { brightness: 1.5, warmth: 2, radio: true, compress: 0.65 }),
  custom:       P('other', { compress: 0.3 }),
};

export const PRESET_IDS = Object.keys(PRESETS);
export function presetsInCategory(cat) { return PRESET_IDS.filter((id) => PRESETS[id].category === cat); }

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
    breath: null, tremor: null, rough: null, brightness: null, warmth: null, radio: null, compress: null, ringMod: null,
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
  const pitchRatio = clamp(Math.pow(2, semis / 12), 0.42, 3.0);
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
    ringMod: clamp(pick(settings.ringMod, base.ringMod), 0, 1),
    ringHz: base.ringHz || 45,
    nr: { enabled: !!(settings.nr && settings.nr.enabled), strength: clamp(settings.nr ? settings.nr.strength : 0.6, 0, 1) },
    gate: { enabled: !!(settings.gate && settings.gate.enabled), thresholdDb: settings.gate ? settings.gate.thresholdDb : -48 },
    normalize: { enabled: !!(settings.normalize && settings.normalize.enabled), targetLufs: settings.normalize ? settings.normalize.targetLufs : -16 },
  };
}
