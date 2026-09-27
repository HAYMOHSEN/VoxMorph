// VoxMorph — application logic (UI, state, rendering, export, PWA)
import { STRINGS, t, setLanguage, detectLanguage, getLanguage, applyI18n, formatTime } from './i18n.js';
import { AudioEngine, RenderWorker, RATE } from './audio-engine.js';
import { PRESETS, PRESET_IDS, defaultSettings, resolveSettings } from './dsp/presets.js';
import { FORMATS, detectSupport, formatAvailable, encodeAudio, saveBlob } from './export/index.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_SECONDS = 10;
const PREVIEW_THRESHOLD = 14;

const state = {
  audio: null, voiceInfo: null,
  trim: { start: 0, end: 0 },
  settings: defaultSettings(),
  converted: null, convertedKey: '',
  preview: null, previewKey: '',
  rendering: false,
  lastPlayed: 'conv',
  support: { wav: true, flac: true, mp3: false, aac: false, opus: false },
  recording: false, live: false,
  peaks: null,
  levelPeak: 0, levelRms: 0, levelHold: 0,
};

const engine = new AudioEngine({
  onLevel: (peak, rms) => { state.levelPeak = peak; state.levelRms = rms; if (peak > state.levelHold) state.levelHold = peak; },
  onRecordingProgress: (sec) => { $('recTime').textContent = formatTime(sec); },
});
const worker = new RenderWorker('./js/dsp/render-worker.js');
let renderTimer = null, liveTimer = null, renderSeq = 0;
let activeRender = { key: '', promise: null };

// ------------------------------------------------------------------ helpers
function toast(msg, kind = '', ms = 3200) {
  const el = $('toast');
  el.textContent = msg; el.className = 'toast ' + kind; el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}
function setStatus(text, kind = '') { const c = $('renderStatus'); c.textContent = text; c.className = 'status-chip ' + kind; }
function showProgress(frac, text) {
  const p = $('progress');
  if (frac === null) { p.hidden = true; return; }
  p.hidden = false; $('progressBar').style.width = `${Math.round(frac * 100)}%`; $('progressText').textContent = text || '';
}
function settingsKey() { return JSON.stringify({ c: state.clipId, s: state.settings, t: state.trim }); }
function selection() {
  if (!state.audio) return null;
  const a = Math.round(state.trim.start * RATE), b = Math.round(state.trim.end * RATE);
  return state.audio.subarray(a, Math.max(a + 1, b));
}
function selectionDuration() { return state.trim.end - state.trim.start; }
function defaultFileName() {
  if (state.nameBase) return `${state.nameBase}-${state.settings.preset}`;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `VoxMorph-${state.settings.preset}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function refreshFileName(force = false) {
  if (force || !state.fileNameDirty) { $('fileName').value = defaultFileName(); state.fileNameDirty = false; }
}

// ------------------------------------------------------------------ waveform
function computePeaks(audio, width) {
  const peaks = new Float32Array(width * 2);
  const step = audio.length / width;
  for (let x = 0; x < width; x++) {
    const s = Math.floor(x * step), e = Math.min(audio.length, Math.floor((x + 1) * step) + 1);
    let mn = 1, mx = -1;
    for (let i = s; i < e; i++) { const v = audio[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn > mx) { mn = 0; mx = 0; }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
  return peaks;
}
function drawWaveform() {
  const canvas = $('waveform');
  const wrap = $('waveWrap');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.floor(wrap.clientWidth * dpr)), h = Math.floor(wrap.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; state.peaks = null; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!state.audio) return;
  if (!state.peaks || state.peaks.length !== w * 2) state.peaks = computePeaks(state.audio, w);
  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#22d3ee'); grad.addColorStop(0.5, '#7c5cff'); grad.addColorStop(1, '#22d3ee');
  ctx.fillStyle = grad;
  const p = state.peaks;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const y1 = mid - p[x * 2 + 1] * mid * 0.92, y2 = mid - p[x * 2] * mid * 0.92;
    ctx.rect(x, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
  }
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.15)';
  ctx.fillRect(0, mid, w, 1);
}
function updateTrimUI() {
  const dur = state.audio ? state.audio.length / RATE : 0;
  const wrap = $('waveWrap');
  const W = wrap.clientWidth;
  const sx = dur ? (state.trim.start / dur) * W : 0, ex = dur ? (state.trim.end / dur) * W : W;
  // the timeline always runs left-to-right (audio-editor convention), whatever the UI direction
  $('shadeStart').style.width = `${Math.max(0, sx)}px`;
  $('shadeEnd').style.width = `${Math.max(0, W - ex)}px`;
  $('trimStartVal').textContent = formatTime(state.trim.start);
  $('trimEndVal').textContent = formatTime(state.trim.end);
  $('durationVal').textContent = formatTime(selectionDuration());
}
function timeToX(sec) {
  const dur = state.audio ? state.audio.length / RATE : 1;
  return (sec / dur) * $('waveWrap').clientWidth;
}
function xToTime(x) {
  const dur = state.audio ? state.audio.length / RATE : 1;
  return Math.max(0, Math.min(dur, (x / $('waveWrap').clientWidth) * dur));
}

// ------------------------------------------------------------------ playback
let rafId = 0;
function tick() {
  const ph = $('playhead');
  if (engine.playing) {
    const pos = engine.position();
    const abs = state.trim.start + pos;
    ph.hidden = false; ph.style.left = `${timeToX(abs)}px`;
    $('timeInfo').textContent = `${formatTime(pos)} / ${formatTime(selectionDuration())}`;
  }
  // level meter
  const rmsDb = 20 * Math.log10(state.levelRms + 1e-6), peakDb = 20 * Math.log10(state.levelHold + 1e-6);
  const pct = Math.max(0, Math.min(100, (rmsDb + 60) / 60 * 100));
  const ppct = Math.max(0, Math.min(100, (peakDb + 60) / 60 * 100));
  $('levelFill').style.width = `${pct}%`;
  $('levelPeak').style.insetInlineStart = `${ppct}%`;
  state.levelHold *= 0.96;
  rafId = requestAnimationFrame(tick);
}
function currentConverted() {
  const key = settingsKey();
  if (state.converted && state.convertedKey === key) return { audio: state.converted, preview: false };
  if (state.preview && state.previewKey === key) return { audio: state.preview, preview: true };
  return null;
}
async function playWhich(which) {
  if (!state.audio) return;
  const wasPlaying = engine.playing, pos = engine.position();
  if (wasPlaying && engine.player.which === which) { engine.pause(); updateTransport(); return; }
  let audio;
  if (which === 'orig') audio = selection();
  else {
    const c = currentConverted();
    if (!c) { toast(t('convertedNotReady')); return; }
    audio = c.audio;
  }
  state.lastPlayed = which;
  const offset = wasPlaying ? pos : engine.player.offset;
  await engine.play(audio, which, offset < audio.length / RATE - 0.05 ? offset : 0, () => { updateTransport(); $('playhead').hidden = true; $('timeInfo').textContent = `0:00.0 / ${formatTime(selectionDuration())}`; });
  updateTransport();
}
function updateTransport() {
  const playing = engine.playing, which = engine.player.which;
  const setBtn = (id, key, isPlaying) => {
    const b = $(id); const svg = b.querySelector('svg path'); const label = b.querySelector('span');
    svg.setAttribute('d', isPlaying ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
    label.textContent = isPlaying ? t('pause') : t(key);
  };
  setBtn('playOrigBtn', 'playOriginal', playing && which === 'orig');
  setBtn('playConvBtn', 'playConverted', playing && which === 'conv');
  $('playOrigBtn').disabled = !state.audio;
  const c = currentConverted();
  $('playConvBtn').disabled = !c;
  if (c && c.preview && !(playing && which === 'conv')) $('playConvBtn').querySelector('span').textContent = `${t('playConverted')} (${PREVIEW_SECONDS}${t('seconds')})`;
  $('saveBtn').disabled = !state.audio;
}

// ------------------------------------------------------------------ clip loading
async function loadClip(audio) {
  engine.stop();
  clearTimeout(renderTimer);
  renderSeq++;
  if (worker.busy) worker.cancelAll();
  state.clipId = (state.clipId || 0) + 1;
  const clipId = state.clipId;
  state.audio = audio; state.peaks = null;
  state.trim = { start: 0, end: audio.length / RATE };
  state.converted = null; state.convertedKey = ''; state.preview = null; state.previewKey = '';
  state.voiceInfo = null;
  $('waveEmpty').hidden = true; $('trimRow').hidden = false;
  $('trimStart').value = 0; $('trimEnd').value = 1000;
  drawWaveform(); updateTrimUI(); updateTransport();
  $('timeInfo').textContent = `0:00.0 / ${formatTime(selectionDuration())}`;
  refreshFileName(true);
  setStatus(t('analyzing'), 'busy');
  let info = null;
  try {
    info = await worker.analyze(audio, RATE);
  } catch (e) { console.warn('voice analysis failed:', e && e.message); }
  if (state.clipId !== clipId) return; // another clip was loaded meanwhile
  state.voiceInfo = info;
  updateDetected();
  syncFineControls();
  scheduleRender(0);
  if (state.live) pushLiveConfig();
}
function updateDetected() {
  const v = state.voiceInfo;
  const el = $('detectedInfo');
  if (!v || !v.f0Median || v.voicedRatio < 0.05) { el.textContent = state.audio ? `${t('detected')}: ${t('voiceUnknown')}` : ''; return; }
  const cls = v.f0Median > 165 ? t('voiceHigh') : t('voiceLow');
  el.textContent = `${t('detected')}: ${cls} · ${Math.round(v.f0Median)} Hz`;
}

// ------------------------------------------------------------------ rendering
function scheduleRender(delay = 250) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, delay);
}
function renderNow() {
  if (!state.audio) return Promise.resolve();
  const key = settingsKey();
  if (state.convertedKey === key && state.converted) { setStatus(t('ready'), 'ok'); updateTransport(); return Promise.resolve(); }
  if (activeRender.promise && activeRender.key === key) return activeRender.promise;
  const promise = runRender(key);
  activeRender = { key, promise };
  return promise;
}
async function runRender(key) {
  const seq = ++renderSeq;
  if (worker.busy) worker.cancelAll();
  const sel = selection();
  const settings = JSON.parse(JSON.stringify(state.settings));
  state.rendering = true;
  setStatus(t('rendering'), 'busy');
  try {
    const dur = sel.length / RATE;
    if (dur > PREVIEW_THRESHOLD && !(state.preview && state.previewKey === key)) {
      const r = await worker.render(sel.subarray(0, PREVIEW_SECONDS * RATE), RATE, settings, state.voiceInfo, null);
      if (seq !== renderSeq) return;
      state.preview = r.audio; state.previewKey = key;
      updateTransport();
    }
    const r = await worker.render(sel, RATE, settings, state.voiceInfo, (p) => { if (seq === renderSeq && dur > 6) setStatus(`${t('rendering')} ${Math.round(p * 100)}%`, 'busy'); });
    if (seq !== renderSeq) return;
    state.converted = r.audio; state.convertedKey = key;
    state.rendering = false;
    setStatus(t('ready'), 'ok');
    updateTransport();
  } catch (e) {
    if (seq !== renderSeq) return;
    state.rendering = false;
    setStatus('');
    if (String(e.message) !== 'cancelled') toast(String(e.message || e), 'error');
  } finally {
    if (activeRender.key === key && seq === renderSeq) activeRender = { key: '', promise: null };
  }
}
async function ensureConvertedFull() {
  const key = settingsKey();
  if (state.converted && state.convertedKey === key) return state.converted;
  clearTimeout(renderTimer);
  await renderNow();
  if (state.converted && state.convertedKey === key) return state.converted;
  throw new Error(t('convertedNotReady'));
}

// ------------------------------------------------------------------ settings ↔ controls
function onSettingsChanged(opts = {}) {
  syncFineControls();
  if (state.audio && !(state.converted && state.convertedKey === settingsKey())) setStatus(t('rendering'), 'busy');
  scheduleRender(opts.immediate ? 0 : 250);
  if (state.live) pushLiveConfig();
  refreshFileName();
}
function selectPreset(id, { keepFine = false } = {}) {
  state.settings.preset = id;
  if (!keepFine) {
    Object.assign(state.settings, { pitchOffset: 0, formantOffset: 0, breath: null, tremor: null, rough: null, brightness: null, warmth: null, radio: null, compress: null });
  }
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === id)));
  onSettingsChanged();
}
function syncFineControls() {
  const s = state.settings;
  const p = resolveSettings(s, state.voiceInfo);
  $('intensity').value = Math.round(s.intensity * 100); $('intensityVal').textContent = `${Math.round(s.intensity * 100)}%`;
  $('autoToggle').checked = !!s.auto;
  $('pitchOffset').value = s.pitchOffset; $('pitchOffsetVal').textContent = `${s.pitchOffset > 0 ? '+' : ''}${s.pitchOffset} ${t('semitones')} (${p.semitones >= 0 ? '+' : ''}${p.semitones.toFixed(1)})`;
  $('formantOffset').value = s.formantOffset; $('formantOffsetVal').textContent = `${s.formantOffset > 0 ? '+' : ''}${s.formantOffset}% (×${p.formantRatio.toFixed(2)})`;
  const setR = (id, v, fmt) => { $(id).value = v; $(id + 'Val').textContent = fmt(v); };
  setR('breath', Math.round(p.breath * 100), (v) => v);
  setR('tremor', Math.round(p.tremor * 100), (v) => v);
  setR('rough', Math.round(p.rough * 100), (v) => v);
  setR('brightness', Math.round(p.brightness * 2) / 2, (v) => `${v > 0 ? '+' : ''}${v} dB`);
  setR('warmth', Math.round(p.warmth * 2) / 2, (v) => `${v > 0 ? '+' : ''}${v} dB`);
  setR('compress', Math.round(p.compress * 100), (v) => v);
  $('radioToggle').checked = p.radio;
  $('nrToggle').checked = s.nr.enabled; $('nrStrength').value = Math.round(s.nr.strength * 100); $('nrStrengthVal').textContent = Math.round(s.nr.strength * 100);
  $('nrStrength').disabled = !s.nr.enabled;
  $('gateToggle').checked = s.gate.enabled;
  $('normToggle').checked = s.normalize.enabled; $('normTarget').value = String(s.normalize.targetLufs); $('normTarget').disabled = !s.normalize.enabled;
}
function bindControls() {
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => selectPreset(b.dataset.preset)));
  $('intensity').addEventListener('input', (e) => { state.settings.intensity = Number(e.target.value) / 100; onSettingsChanged(); });
  $('autoToggle').addEventListener('change', (e) => { state.settings.auto = e.target.checked; onSettingsChanged(); });
  $('pitchOffset').addEventListener('input', (e) => { state.settings.pitchOffset = Number(e.target.value); onSettingsChanged(); });
  $('formantOffset').addEventListener('input', (e) => { state.settings.formantOffset = Number(e.target.value); onSettingsChanged(); });
  const bindEffect = (id, scale = 1) => $(id).addEventListener('input', (e) => { state.settings[id] = Number(e.target.value) / scale; onSettingsChanged(); });
  bindEffect('breath', 100); bindEffect('tremor', 100); bindEffect('rough', 100); bindEffect('compress', 100); bindEffect('brightness'); bindEffect('warmth');
  $('radioToggle').addEventListener('change', (e) => { state.settings.radio = e.target.checked; onSettingsChanged(); });
  $('nrToggle').addEventListener('change', (e) => { state.settings.nr.enabled = e.target.checked; onSettingsChanged(); });
  $('nrStrength').addEventListener('input', (e) => { state.settings.nr.strength = Number(e.target.value) / 100; onSettingsChanged(); });
  $('gateToggle').addEventListener('change', (e) => { state.settings.gate.enabled = e.target.checked; onSettingsChanged(); });
  $('normToggle').addEventListener('change', (e) => { state.settings.normalize.enabled = e.target.checked; onSettingsChanged(); });
  $('normTarget').addEventListener('change', (e) => { state.settings.normalize.targetLufs = Number(e.target.value); onSettingsChanged(); });
  $('resetFine').addEventListener('click', () => selectPreset(state.settings.preset));
  $('savePresetBtn').addEventListener('click', () => {
    try { localStorage.setItem('voxmorph.mypreset', JSON.stringify(state.settings)); $('myPresetBtn').hidden = false; toast(t('presetSaved'), 'ok'); } catch { /* ignore */ }
  });
  $('myPresetBtn').addEventListener('click', () => {
    try {
      const s = JSON.parse(localStorage.getItem('voxmorph.mypreset'));
      if (s) { state.settings = Object.assign(defaultSettings(), s); selectPreset(state.settings.preset, { keepFine: true }); }
    } catch { /* ignore */ }
  });
  try { if (localStorage.getItem('voxmorph.mypreset')) $('myPresetBtn').hidden = false; } catch { /* ignore */ }
}

// ------------------------------------------------------------------ live monitoring
function pushLiveConfig() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    const params = resolveSettings(state.settings, state.voiceInfo);
    engine.configureLive(params, state.voiceInfo);
  }, 120);
}
async function setLive(on) {
  if (on) {
    try {
      await engine.ensureContext();
      if (!engine.micOpen) await engine.openMic($('micSelect').value);
      const params = resolveSettings(state.settings, state.voiceInfo);
      engine.configureLive(params, state.voiceInfo);
      engine.setMonitor(true);
      state.live = true;
    } catch (e) {
      state.live = false; $('liveToggle').checked = false;
      toast(t('micError'), 'error');
    }
  } else {
    state.live = false;
    engine.setMonitor(false);
    if (!state.recording) engine.closeMic();
  }
}

// ------------------------------------------------------------------ recording
async function toggleRecording() {
  if (state.recording) {
    state.nameBase = '';
    state.recording = false;
    $('recordBtn').classList.remove('recording');
    $('recordBtn').querySelector('.label').textContent = t('record');
    $('recTime').hidden = true;
    const audio = await engine.stopRecording();
    if (!state.live) engine.closeMic();
    if (audio.length < RATE * 0.2) { toast(t('noClip')); return; }
    await loadClip(audio);
    return;
  }
  try {
    await engine.ensureContext();
    if (!engine.micOpen) await engine.openMic($('micSelect').value);
    await refreshMics();
    engine.stop(); updateTransport();
    engine.startRecording();
    state.recording = true;
    $('recordBtn').classList.add('recording');
    $('recordBtn').querySelector('.label').textContent = t('stop');
    $('recTime').hidden = false; $('recTime').textContent = '0:00.0';
  } catch (e) {
    toast(t('micError'), 'error');
  }
}
async function refreshMics() {
  const mics = await engine.listMicrophones();
  const sel = $('micSelect');
  const cur = sel.value;
  sel.innerHTML = '';
  const def = document.createElement('option'); def.value = ''; def.textContent = t('defaultDevice'); sel.appendChild(def);
  for (const m of mics) {
    if (!m.deviceId || m.deviceId === 'default') continue;
    const o = document.createElement('option'); o.value = m.deviceId; o.textContent = m.label || `${t('micDevice')} ${sel.length}`; sel.appendChild(o);
  }
  sel.value = cur;
}

// ------------------------------------------------------------------ import
async function importFile(file) {
  if (!file) return;
  engine.stop(); updateTransport();
  setStatus(t('decoding'), 'busy');
  try {
    await engine.ensureContext();
    const audio = await engine.decodeFile(file, (s) => setStatus(t(s), 'busy'));
    if (!audio || audio.length < RATE * 0.1) throw new Error('empty');
    state.nameBase = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    await loadClip(audio);
  } catch (e) {
    setStatus('');
    toast(t('fileError'), 'error');
  }
}

// ------------------------------------------------------------------ export
function populateFormats() {
  const sel = $('formatSelect');
  const saved = (() => { try { return JSON.parse(localStorage.getItem('voxmorph.export') || '{}'); } catch { return {}; } })();
  sel.innerHTML = '';
  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f.id;
    const ok = formatAvailable(f, state.support);
    o.textContent = f.label + (f.lossless ? ` (${t('lossless')})` : '') + (ok ? '' : ` — ${f.id === 'mp3' ? t('mp3Missing') : t('unsupported')}`);
    o.disabled = !ok;
    sel.appendChild(o);
  }
  sel.value = saved.format && formatAvailable(FORMATS.find((f) => f.id === saved.format) || {}, state.support) ? saved.format : 'wav';
  populateQuality(saved);
}
function populateQuality(saved = {}) {
  const f = FORMATS.find((x) => x.id === $('formatSelect').value) || FORMATS[0];
  const q = $('qualitySelect'); q.innerHTML = '';
  if (f.bits) for (const b of f.bits) { const o = document.createElement('option'); o.value = `b${b}`; o.textContent = `${b} ${t('bit')}`; q.appendChild(o); }
  if (f.bitrates) for (const b of f.bitrates) { const o = document.createElement('option'); o.value = `k${b}`; o.textContent = `${b} ${t('kbps')}`; q.appendChild(o); }
  if (saved.quality && [...q.options].some((o) => o.value === saved.quality)) q.value = saved.quality;
  else q.value = f.bits ? 'b16' : (f.bitrates.includes(128) ? 'k128' : `k${f.bitrates[0]}`);
  const r = $('rateSelect'); r.innerHTML = '';
  for (const rate of f.rates) { const o = document.createElement('option'); o.value = String(rate); o.textContent = `${rate / 1000} kHz`; r.appendChild(o); }
  r.value = saved.rate && f.rates.includes(Number(saved.rate)) ? String(saved.rate) : String(f.rates[0]);
}
async function doSave() {
  if (!state.audio) return;
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    showProgress(0.05, t('rendering'));
    const audio = await ensureConvertedFull();
    showProgress(0.6, t('saving'));
    const format = $('formatSelect').value, q = $('qualitySelect').value, rate = Number($('rateSelect').value);
    try { localStorage.setItem('voxmorph.export', JSON.stringify({ format, quality: q, rate })); } catch { /* ignore */ }
    const opts = { format, sampleRate: rate, bits: q.startsWith('b') ? Number(q.slice(1)) : 16, bitrate: q.startsWith('k') ? Number(q.slice(1)) : 128 };
    const { blob, ext } = await encodeAudio(audio, RATE, opts);
    showProgress(0.95, t('saving'));
    let name = ($('fileName').value || defaultFileName()).trim().replace(/[\\/:*?"<>|]+/g, '-');
    if (!name.toLowerCase().endsWith('.' + ext)) name += '.' + ext;
    const res = await saveBlob(blob, name, 'VoxMorph audio');
    showProgress(null);
    if (res.saved) toast(`${t('saved')}: ${res.name}`, 'ok');
  } catch (e) {
    showProgress(null);
    toast(String(e.message || e), 'error');
  } finally {
    btn.disabled = !state.audio;
  }
}

// ------------------------------------------------------------------ trim + seeking
function bindTrim() {
  const clampTrim = () => {
    const dur = state.audio ? state.audio.length / RATE : 0;
    let s = Number($('trimStart').value) / 1000 * dur, e = Number($('trimEnd').value) / 1000 * dur;
    if (e - s < 0.2) { if (e < dur - 0.2) e = s + 0.2; else s = e - 0.2; }
    state.trim = { start: Math.max(0, s), end: Math.min(dur, e) };
    $('trimStart').value = Math.round(state.trim.start / dur * 1000); $('trimEnd').value = Math.round(state.trim.end / dur * 1000);
  };
  const onTrim = () => { if (!state.audio) return; engine.stop(); clampTrim(); updateTrimUI(); updateTransport(); $('timeInfo').textContent = `0:00.0 / ${formatTime(selectionDuration())}`; setStatus(t('rendering'), 'busy'); scheduleRender(300); };
  $('trimStart').addEventListener('input', onTrim);
  $('trimEnd').addEventListener('input', onTrim);
  $('resetTrim').addEventListener('click', () => { if (!state.audio) return; $('trimStart').value = 0; $('trimEnd').value = 1000; onTrim(); });
  $('waveWrap').addEventListener('click', (e) => {
    if (!state.audio) return;
    const rect = $('waveWrap').getBoundingClientRect();
    const tAbs = xToTime(e.clientX - rect.left);
    const rel = Math.max(0, Math.min(selectionDuration(), tAbs - state.trim.start));
    if (engine.playing) { const which = engine.player.which; engine.pause(); engine.player.offset = rel; playWhich(which); }
    else { engine.player.offset = rel; $('playhead').hidden = false; $('playhead').style.left = `${timeToX(state.trim.start + rel)}px`; $('timeInfo').textContent = `${formatTime(rel)} / ${formatTime(selectionDuration())}`; }
  });
}

// ------------------------------------------------------------------ PWA
function setupPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast(t('updateReady'), '', 6000); });
        });
      } catch { /* ignore */ }
    });
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('installBtn').hidden = true; });
}

// ------------------------------------------------------------------ init
async function init() {
  setLanguage(detectLanguage());
  bindControls(); bindTrim();
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === state.settings.preset)));
  syncFineControls();
  // Optional MP3 encoder (LGPL lamejs) — only used when the file is present in vendor/
  await new Promise((res) => { const sc = document.createElement('script'); sc.src = './vendor/lame.min.js'; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
  state.support = await detectSupport();
  populateFormats();
  $('formatSelect').addEventListener('change', () => populateQuality());
  refreshFileName(true);
  $('fileName').addEventListener('input', () => { state.fileNameDirty = true; });

  $('recordBtn').addEventListener('click', toggleRecording);
  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
  $('playOrigBtn').addEventListener('click', () => playWhich('orig'));
  $('playConvBtn').addEventListener('click', () => playWhich('conv'));
  $('liveToggle').addEventListener('change', (e) => setLive(e.target.checked));
  $('micSelect').addEventListener('change', async () => { if (engine.micOpen) { try { await engine.openMic($('micSelect').value); } catch { toast(t('micError'), 'error'); } } });
  $('micSelect').addEventListener('focus', refreshMics);
  $('saveBtn').addEventListener('click', doSave);
  $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
  $('langBtn').addEventListener('click', () => { setLanguage(getLanguage() === 'ar' ? 'en' : 'ar'); populateFormats(); syncFineControls(); updateDetected(); updateTransport(); drawWaveform(); updateTrimUI(); refreshMics(); });

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) importFile(f); });

  // keyboard
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'Space') { e.preventDefault(); if (state.audio) playWhich(engine.playing ? engine.player.which : state.lastPlayed); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecording(); }
  });

  new ResizeObserver(() => { drawWaveform(); updateTrimUI(); }).observe($('waveWrap'));
  refreshMics();
  updateTransport();
  setupPwa();
  tick();
  // expose for tests
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launch) => { if (launch.files && launch.files.length) { try { importFile(await launch.files[0].getFile()); } catch { /* ignore */ } } });
  }
  window.__voxmorph = { state, engine, loadClip, renderNow, ensureConvertedFull, encodeAudio, selectPreset, importFile, resolveSettings, settingsKey };
}

init();
