// VoxMorph — offline rendering and music mixing in a Web Worker (module worker).
import { renderOffline, analyzeVoice } from './pipeline.js';
import { mixWithMusic, musicLoudness } from './mixer.js';

let music = null; // { id, L, R, lufs }

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'analyze') {
      const info = analyzeVoice(m.audio, m.fs);
      self.postMessage({ id: m.id, done: true, info: { f0Median: info.f0Median, f0Mean: info.f0Mean, voicedRatio: info.voicedRatio, lufs: info.lufs, peak: info.peak, voiceClass: info.voiceClass, rmsDb: info.rmsDb } });
    } else if (m.cmd === 'render') {
      let last = 0;
      const r = renderOffline(m.audio, m.fs, m.settings, {
        voiceInfo: m.voiceInfo || null,
        onProgress: (p) => { if (p - last >= 0.04 || p >= 1) { last = p; self.postMessage({ id: m.id, progress: p }); } },
      });
      self.postMessage({ id: m.id, done: true, audio: r.audio, params: r.params, gain: r.gain, voiceInfo: { f0Median: r.voiceInfo.f0Median, voicedRatio: r.voiceInfo.voicedRatio, voiceClass: r.voiceInfo.voiceClass, lufs: r.voiceInfo.lufs } }, [r.audio.buffer]);
    } else if (m.cmd === 'setMusic') {
      music = { id: m.musicId, L: m.L, R: m.R || m.L, lufs: musicLoudness(m.L, m.R || m.L, m.fs) };
      self.postMessage({ id: m.id, done: true, musicId: m.musicId, lufs: music.lufs });
    } else if (m.cmd === 'clearMusic') {
      music = null;
      self.postMessage({ id: m.id, done: true });
    } else if (m.cmd === 'mix') {
      if (!music || music.id !== m.musicId) throw new Error('music not loaded');
      const r = mixWithMusic(m.voice, music, m.fs, m.opts || {});
      const L = r.L.slice(), R = r.R.slice();
      self.postMessage({ id: m.id, done: true, L, R, voiceStart: r.voiceStart }, [L.buffer, R.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
