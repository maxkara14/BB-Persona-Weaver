import test from 'node:test';
import assert from 'node:assert/strict';
import { createId } from './ids.mjs';

test('native randomUUID is used with its original receiver when available', () => {
    const api = { randomUUID() { assert.equal(this, api); return 'native-id'; }, getRandomValues() { throw Error('Unexpected fallback'); } };
    assert.equal(createId(api), 'native-id');
});

test('HTTP fallback creates UUID v4 using getRandomValues with the correct receiver', () => {
    const api = { getRandomValues(bytes) { assert.equal(this, api); assert.equal(bytes.length, 16); return bytes.fill(255); } };
    assert.equal(createId(api), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    api.randomUUID = null;
    assert.equal(createId(api), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('fallback uses fresh random bytes for each ID and retains UUID version and variant', () => {
    const api = { getRandomValues: bytes => crypto.getRandomValues(bytes) };
    const ids = Array.from({ length: 1000 }, () => createId(api));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('missing cryptographic APIs produce a clear error instead of weak random IDs', () => {
    for (const api of [null, {}]) assert.throws(() => createId(api), /безопасную генерацию ID/);
});
