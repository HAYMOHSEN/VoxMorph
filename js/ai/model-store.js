// VoxMorph AI — model download + offline storage (Cache Storage). Works in Workers and windows.
//
// Large models are stored as 16 MiB Cache Storage entries to avoid browser limits on single entries.
// Published model `parts` are stitched during download; cached chunks are joined when the model is loaded.

const CACHE_NAME = 'voxmorph-models-v1';
const CACHE_CHUNK_SIZE = 16 * 1024 * 1024;
const keyFor = (id) => `https://models.voxmorph.local/${encodeURIComponent(id)}`;
const chunkKeyFor = (id, token, index) => `${keyFor(id)}/chunks/${token}/${index}`;

async function openCache() {
  if (typeof caches === 'undefined') throw new Error('Cache Storage is not available');
  return caches.open(CACHE_NAME);
}

async function storedChunks(cache, id) {
  const res = await cache.match(keyFor(id));
  const count = Number(res && res.headers.get('x-chunk-count'));
  const token = res && res.headers.get('x-chunk-token');
  return count > 0 && token ? { count, token } : null;
}

async function deleteChunks(cache, id, info) {
  if (!info) return;
  for (let i = 0; i < info.count; i++) await cache.delete(chunkKeyFor(id, info.token, i));
}

async function storeModel(cache, id, bytes, headers) {
  const previous = await storedChunks(cache, id);
  if (bytes.byteLength <= CACHE_CHUNK_SIZE) {
    await cache.put(keyFor(id), new Response(bytes, { headers }));
    await deleteChunks(cache, id, previous);
    return;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const count = Math.ceil(bytes.byteLength / CACHE_CHUNK_SIZE);
  let written = 0;
  try {
    for (let i = 0; i < count; i++) {
      const start = i * CACHE_CHUNK_SIZE;
      const chunk = bytes.subarray(start, Math.min(start + CACHE_CHUNK_SIZE, bytes.byteLength));
      await cache.put(chunkKeyFor(id, token, i), new Response(chunk, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Part': String(i) },
      }));
      written++;
    }
    await cache.put(keyFor(id), new Response(null, {
      headers: { ...headers, 'X-Chunk-Count': String(count), 'X-Chunk-Token': token },
    }));
  } catch (e) {
    await deleteChunks(cache, id, { count: written, token });
    throw e;
  }
  await deleteChunks(cache, id, previous);
}

export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}

export async function storageEstimate() {
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; } } catch { /* ignore */ }
  return { usage: 0, quota: 0 };
}

/** Installed model ids with sizes and the manifest entry they were installed from. */
export async function installedModels() {
  const cache = await openCache();
  const keys = await cache.keys();
  const out = [];
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    if (res.headers.has('x-chunk-part')) continue;
    const id = decodeURIComponent(req.url.split('/').pop());
    out.push({ id, size: Number(res.headers.get('x-size') || 0), sha256: res.headers.get('x-sha256') || '', version: res.headers.get('x-version') || '' });
  }
  return out;
}

export async function isInstalled(id, expectedSha = '') {
  const cache = await openCache();
  const res = await cache.match(keyFor(id));
  if (!res) return false;
  if (expectedSha) { const have = res.headers.get('x-sha256') || ''; if (have && have !== expectedSha) return false; }
  return true;
}

export async function removeModel(id) {
  const cache = await openCache();
  const chunks = await storedChunks(cache, id);
  const removed = await cache.delete(keyFor(id));
  await deleteChunks(cache, id, chunks);
  return removed;
}

export async function loadModelBytes(id) {
  const cache = await openCache();
  const res = await cache.match(keyFor(id));
  if (!res) throw new Error(`model ${id} is not installed`);
  const chunks = await storedChunks(cache, id);
  if (chunks) {
    const size = Number(res.headers.get('x-size') || 0);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`model ${id} has an invalid stored size`);
    const all = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < chunks.count; i++) {
      const part = await cache.match(chunkKeyFor(id, chunks.token, i));
      if (!part) throw new Error(`model ${id} is incomplete (missing chunk ${i + 1}/${chunks.count})`);
      const bytes = new Uint8Array(await part.arrayBuffer());
      if (offset + bytes.byteLength > size) throw new Error(`model ${id} has oversized stored chunks`);
      all.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== size) throw new Error(`model ${id} size mismatch: expected ${size} bytes, got ${offset}`);
    return all.buffer;
  }
  return res.arrayBuffer();
}

async function sha256Hex(buffer) {
  const d = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function resolveUrl(u, base) {
  try { return new URL(u, base || (typeof location !== 'undefined' ? location.href : undefined)).href; } catch { return u; }
}

/**
 * Download a model (one url or several parts) with progress and store it offline.
 * @param {{id:string, url?:string, parts?:string[], size?:number, sha256?:string, version?:string}} item
 * @param {(loaded:number, total:number)=>void} onProgress
 * @param {AbortSignal} [signal]
 * @param {string} [baseUrl] base for relative urls (e.g. the manifest's url)
 */
export async function installModel(item, onProgress = () => {}, signal = null, baseUrl = '') {
  const urls = (item.parts && item.parts.length ? item.parts : [item.url]).map((u) => resolveUrl(u, baseUrl));
  const total = item.size || 0;
  if (total) { // fail early with a clear message instead of a 'Quota exceeded' after a long download
    const est = await storageEstimate();
    if (est.quota && est.quota - est.usage < total * 1.05) {
      const err = new Error(`not enough browser storage for this model: it needs ${(total / 1e6).toFixed(0)} MB but only ${Math.max(0, (est.quota - est.usage) / 1e6).toFixed(0)} MB is available (quota ${(est.quota / 1e9).toFixed(1)} GB)`);
      err.code = 'quota'; throw err;
    }
  }
  const chunks = [];
  let loaded = 0;
  for (const url of urls) {
    let res;
    try { res = await fetch(url, { mode: 'cors', signal, cache: 'no-store' }); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw new Error(`download failed for ${url}: ${e && e.message ? e.message : e}`); }
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    if (!res.body) { const buf = new Uint8Array(await res.arrayBuffer()); chunks.push(buf); loaded += buf.length; onProgress(loaded, total || loaded); continue; }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total || Number(res.headers.get('content-length')) || loaded);
    }
  }
  let size = 0; for (const c of chunks) size += c.length;
  const all = new Uint8Array(size);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  if (item.size && size !== item.size) throw new Error(`size mismatch: expected ${item.size} bytes, got ${size}`);
  let sha = '';
  if (item.sha256) {
    sha = await sha256Hex(all.buffer);
    if (sha.toLowerCase() !== String(item.sha256).toLowerCase()) throw new Error('checksum mismatch — the download is corrupted or the file changed');
  }
  const cache = await openCache();
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Size': String(size), 'X-Sha256': sha || (item.sha256 || ''), 'X-Version': String(item.version || '') };
  try { await storeModel(cache, item.id, all, headers); }
  catch (e) { if (e && /quota/i.test(e.name + ' ' + e.message)) { const err = new Error(`not enough browser storage to keep this model (${(size / 1e6).toFixed(0)} MB): ${e.message}`); err.code = 'quota'; throw err; } throw e; }
  await requestPersistence();
  return { id: item.id, size, sha256: sha };
}

/** Store model bytes that came from a local file (no download). */
export async function installFromBuffer(id, buffer, meta = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let sha = '';
  try { sha = await sha256Hex(u8.buffer.byteLength === u8.byteLength ? u8.buffer : u8.slice().buffer); } catch { /* ignore */ }
  const cache = await openCache();
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Size': String(u8.byteLength), 'X-Sha256': sha, 'X-Version': String(meta.version || 'local') };
  await storeModel(cache, id, u8, headers);
  await requestPersistence();
  return { id, size: u8.byteLength, sha256: sha };
}
