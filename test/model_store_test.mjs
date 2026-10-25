import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installFromBuffer, installModel, installedModels, isInstalled, loadModelBytes, removeModel } from '../js/ai/model-store.js';

const CHUNK_SIZE = 16 * 1024 * 1024;
const data = new Uint8Array(CHUNK_SIZE * 2 + 37);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
const sha256 = createHash('sha256').update(data).digest('hex');
const entries = new Map();
const cacheKey = (request) => typeof request === 'string' ? request : request.url;
Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
  open: async () => ({
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    match: async (request) => entries.get(cacheKey(request))?.clone(),
    put: async (request, response) => entries.set(cacheKey(request), new Response(await response.arrayBuffer(), { headers: response.headers })),
    delete: async (request) => entries.delete(cacheKey(request)),
  }),
} });

const source = data.slice();
globalThis.fetch = async () => new Response(source.slice());

const item = { id: 'large-model', url: 'https://example.test/model.onnx', size: data.byteLength, sha256, version: '1' };
await installModel(item);
assert.equal([...entries.values()].filter((res) => res.headers.has('x-chunk-part')).length, 3);
assert.equal(await isInstalled(item.id, sha256), true);
assert.deepEqual(await installedModels(), [{ id: item.id, size: data.byteLength, sha256, version: '1' }]);
assert.equal(createHash('sha256').update(new Uint8Array(await loadModelBytes(item.id))).digest('hex'), sha256);
assert.equal(await removeModel(item.id), true);
assert.equal(entries.size, 0);

await installFromBuffer('local-large-model', data);
assert.equal(createHash('sha256').update(new Uint8Array(await loadModelBytes('local-large-model'))).digest('hex'), sha256);
assert.equal(await removeModel('local-large-model'), true);
assert.equal(entries.size, 0);

console.log('Large downloaded and imported models are chunked, verified, reassembled, and removable.');
