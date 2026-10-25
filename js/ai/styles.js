// VoxMorph AI — voice *styles* derived from the neural base voices.
//
// A neural (RVC) voice gives a natural woman or man. A style keeps that natural timbre and turns it into a
// child, a teenager or an elderly person by (1) asking the neural generator for the right pitch (the f0 it is
// conditioned on is shifted towards `targetF0`, so the pitch change is synthesised, not post-processed) and
// (2) running VoxMorph's character layer on the result: vocal-tract (formant) scaling, breath, tremor,
// roughness, brightness and warmth. The style says which *kind* of base voice it needs (`base`: a voice
// category from the model pack); the app picks the installed voice of that category.
//
// Fields: base (category of the neural voice), category (tab the style belongs to), targetF0 (Hz, auto mode),
// semis (fixed-mode transpose, semitones), formant (ratio applied to the neural output; 1 = unchanged),
// breath / tremor / rough (0..1), brightness / warmth (dB), compress (0..1).

const S = (o) => Object.assign({ semis: 0, formant: 1, breath: 0, tremor: 0, rough: 0, brightness: 0, warmth: 0, compress: 0.35 }, o);

export const AI_STYLES = {
  // children: the female model at a child's pitch, with a shorter vocal tract
  ai_girl:      S({ base: 'woman', category: 'child', targetF0: 275, semis: 5,  formant: 1.14, breath: 0.12, brightness: 1.5, compress: 0.4 }),
  ai_boy:       S({ base: 'woman', category: 'child', targetF0: 245, semis: 3,  formant: 1.07, breath: 0.05, rough: 0.05, brightness: 0.5, compress: 0.4 }),
  // elderly: slower, breathier, slightly hoarse voices with a vocal tremor and less high-frequency energy
  ai_old_woman: S({ base: 'woman', category: 'woman', targetF0: 170, semis: -2, formant: 0.97, breath: 0.22, tremor: 0.7, rough: 0.10, brightness: -2.5, warmth: 1 }),
  ai_old_man:   S({ base: 'man',   category: 'man',   targetF0: 125, semis: 1,  formant: 0.98, breath: 0.18, tremor: 0.8, rough: 0.14, brightness: -3, warmth: 1 }),
};

export const AI_STYLE_IDS = Object.keys(AI_STYLES);

/** Preset ids: 'ai:<voiceId>' selects a neural voice as is, 'ais:<styleId>' a derived style. */
export const isAiVoiceId = (id) => typeof id === 'string' && id.startsWith('ai:');
export const isAiStyleId = (id) => typeof id === 'string' && id.startsWith('ais:');
export const styleOf = (id) => (isAiStyleId(id) ? AI_STYLES[id.slice(4)] || null : null);

/**
 * The neural voice a style runs on: the installed voice of the style's base category (the first one, or the
 * one the user chose), otherwise the first voice of that category in the pack so the UI can offer its download.
 * @param {object} style  AI_STYLES entry
 * @param {Array} voices  ai.voices
 * @param {(id:string)=>boolean} isInstalled
 * @param {string|null} preferredId  user's choice for this category, if any
 */
export function baseVoiceFor(style, voices, isInstalled, preferredId = null) {
  if (!style) return null;
  const candidates = voices.filter((v) => v.category === style.base);
  if (!candidates.length) return null;
  if (preferredId) { const p = candidates.find((v) => v.id === preferredId); if (p) return p; }
  return candidates.find((v) => isInstalled(v.id)) || candidates[0];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Transpose (semitones) for the neural generator: towards `targetF0` when the speaker's pitch is known
 * (auto mode), otherwise the style's fixed offset; the user's pitch offset is added either way.
 */
export function aiTranspose(settings, voice, style, voiceInfo) {
  const target = style ? style.targetF0 : (voice && voice.targetF0) || null;
  const f0 = voiceInfo && voiceInfo.f0Median > 0 ? voiceInfo.f0Median : 0;
  let semis = 0;
  if (settings.auto && target && f0) semis = Math.round(12 * Math.log2(target / f0));
  else if (settings.auto && voice && typeof voice.transposeDefault === 'number' && !style) semis = voice.transposeDefault;
  else if (!settings.auto && style) semis = style.semis;
  return clamp(semis + (settings.pitchOffset || 0), -24, 24);
}

/**
 * Settings for the DSP character layer applied to the neural output (no pitch shift there — the generator did
 * it). Style amounts scale with `intensity`; the fine controls override them when the user touched them.
 * @param {object} settings  user settings
 * @param {object|null} style  AI_STYLES entry or null for a plain neural voice
 * @param {object} neutral  the app's NEUTRAL settings object
 */
export function aiPostSettings(settings, style, neutral) {
  const s = clamp(settings.intensity ?? 1, 0.25, 1.5);
  const st = style || S({});
  const pick = (override, base) => (override === null || override === undefined ? base : override);
  const formant = Math.pow(st.formant, s) * (1 + (settings.formantOffset || 0) / 100);
  return {
    ...neutral,
    formantOffset: (clamp(formant, 0.6, 1.7) - 1) * 100,
    breath: clamp(pick(settings.breath, st.breath * s), 0, 1.5),
    tremor: clamp(pick(settings.tremor, st.tremor * s), 0, 1.5),
    rough: clamp(pick(settings.rough, st.rough * s), 0, 1),
    brightness: clamp(pick(settings.brightness, st.brightness * s), -8, 8),
    warmth: clamp(pick(settings.warmth, st.warmth * s), -8, 8),
    radio: !!pick(settings.radio, false),
    compress: clamp(pick(settings.compress, st.compress), 0, 1),
    gate: settings.gate,
    normalize: settings.normalize,
  };
}
