import test from 'node:test';
import assert from 'node:assert/strict';
import { createAndBindBook, validateBookName } from './create-book.mjs';

function fixture() {
    const calls = []; let current = true;
    return { calls, set current(value) { current = value; }, adapter: {
        list: async () => ['Existing'],
        assertCurrent: () => { if (!current) throw new Error('changed context'); },
        write: async (name, data) => { calls.push(['write', name, data]); },
        bind: async name => { calls.push(['bind', name]); },
    } };
}
test('creates an empty book and binds only after confirmed write', async () => {
    const f = fixture();
    assert.equal(await createAndBindBook('  Новая книга  ', f.adapter), 'Новая книга');
    assert.deepEqual(f.calls, [['write', 'Новая книга', { entries: {} }], ['bind', 'Новая книга']]);
});
test('existing name, including case variant, is never overwritten', async () => {
    const f = fixture();
    await assert.rejects(() => createAndBindBook('existing', f.adapter), /уже существует/);
    assert.deepEqual(f.calls, []);
});
test('rejects unsafe or empty filenames before network access', () => {
    for (const name of ['', ' ', '../x', 'a/b', 'a\\b', 'CON', 'nul.json', 'book.', 'x'.repeat(121)]) assert.throws(() => validateBookName(name));
    assert.equal(validateBookName('Ая — лорбук'), 'Ая — лорбук');
});
test('failed write or context switch never changes persona binding', async () => {
    const f = fixture();
    f.adapter.write = async () => { throw new Error('write failed'); };
    await assert.rejects(() => createAndBindBook('New', f.adapter), /write failed/); assert.deepEqual(f.calls, []);
    f.adapter.write = async () => { f.current = false; };
    await assert.rejects(() => createAndBindBook('New', f.adapter), /changed context/); assert.deepEqual(f.calls, []);
});
