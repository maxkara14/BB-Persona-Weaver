import test from 'node:test';
import assert from 'node:assert/strict';
import { contextIdentity, selectSources, sourcesAreCurrent, validateSuggestions, entryLabels, rangeCoverage, canRestore } from './core.mjs';

const chat = [
    { mes: 'Мать научила меня зашивать раны.', name: 'Ая', is_user: true },
    { mes: 'Она уверенно наложила шов.', name: 'Рассказчик', swipe_id: 0 },
    { mes: 'Скрытая деталь', is_system: true },
];
const sources = selectSources(chat, 0, 2);
const draft = () => ({ suggestions: [{ target: null, category: 'skills', title: 'Первая помощь',
    content: 'Умеет зашивать раны; научилась у матери.', reason: 'Прямое утверждение персоны.',
    conflict: false, evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] });

test('context distinguishes persona, owner, group and branch without depending on chat title', () => {
    const identity = { persona: 'aya.png', character: 'npc.png', integrity: 'original' };
    const key = contextIdentity(identity);
    assert.equal(key, contextIdentity({ ...identity, chatTitle: 'renamed' }));
    for (const change of [{ persona: 'other.png' }, { character: 'other.png' }, { integrity: 'branch' }, { group: '1' }]) {
        assert.notEqual(key, contextIdentity({ ...identity, ...change }));
    }
    assert.throws(() => contextIdentity({ ...identity, integrity: '' }));
});

test('range is inclusive and hidden messages require opt-in', () => {
    assert.deepEqual(sources.map(source => source.id), [0, 1]);
    assert.equal(selectSources(chat, 0, 2, { includeHidden: true }).length, 3);
    for (const range of [[-1, 1], [1, 0], [0, 3], [0.5, 1]]) assert.throws(() => selectSources(chat, ...range));
});

test('editing, deletion, authorship, hiding and swipe changes invalidate sources', () => {
    assert.equal(sourcesAreCurrent(chat, sources), true);
    for (const patch of [{ mes: 'Другое' }, { is_user: false }, { name: 'Другой' }, { is_system: true }]) {
        const changed = structuredClone(chat);
        Object.assign(changed[0], patch);
        assert.equal(sourcesAreCurrent(changed, sources), false);
    }
    const changed = structuredClone(chat);
    changed[1].swipe_id = 1;
    assert.equal(sourcesAreCurrent(changed, sources), false);
    assert.equal(sourcesAreCurrent([], sources), false);
});

test('valid fact stays pending and author attribution comes from source, not model', () => {
    const result = draft();
    result.suggestions[0].status = 'applied';
    result.suggestions[0].evidence[0].author = 'model';
    const [suggestion] = validateSuggestions(result, { sources });
    assert.equal(suggestion.status, 'pending');
    assert.equal(suggestion.modelAuthored, false);
    result.suggestions[0].evidence = [{ messageId: 1, quote: 'уверенно наложила шов' }];
    assert.equal(validateSuggestions(result, { sources })[0].modelAuthored, true);
});

test('empty result is valid; invented quotes, out-of-range and missing evidence are rejected', () => {
    assert.deepEqual(validateSuggestions({ suggestions: [] }, { sources }), []);
    for (const evidence of [[], [{ messageId: 2, quote: 'Скрытая деталь' }], [{ messageId: 0, quote: 'Врач' }]]) {
        const result = draft();
        result.suggestions[0].evidence = evidence;
        assert.throws(() => validateSuggestions(result, { sources }));
    }
});

test('updates may only target supplied managed entries and preserve baseline for review', () => {
    const result = draft();
    result.suggestions[0].target = '7';
    assert.throws(() => validateSuggestions(result, { sources }));
    const [suggestion] = validateSuggestions(result, { sources, entries: [{ id: '7', content: 'Ранее известное' }] });
    assert.equal(suggestion.before, 'Ранее известное');
    result.suggestions.push(structuredClone(result.suggestions[0]));
    assert.throws(() => validateSuggestions(result, { sources, entries: [{ id: '7', content: '' }] }));
});

test('wrong schema and duplicate new sections do not produce writable proposals', () => {
    for (const patch of [{ category: '__proto__' }, { category: ['skills'] }, { conflict: 'false' }, { target: 1 }, { content: ' ' }]) {
        const result = draft();
        Object.assign(result.suggestions[0], patch);
        assert.throws(() => validateSuggestions(result, { sources }));
    }
    const result = draft();
    result.suggestions.push(structuredClone(result.suggestions[0]));
    assert.throws(() => validateSuggestions(result, { sources }));
});

test('informational labels combine multiple chats and general origins without altering activation', () => {
    const entry = { disable: false, constant: true, personaCanon: { origins: [
        { kind: 'chat', context: 'a', chatName: 'Первая история' },
        { kind: 'general', context: 'a', chatName: 'Первая история' },
        { kind: 'chat', context: 'b', chatName: 'Другая история' },
    ] } };
    assert.deepEqual(entryLabels(entry), ['Из чата: Первая история', 'Общее', 'Из чата: Другая история']);
    assert.equal(entry.disable, false); assert.equal(entry.constant, true);
});

test('coverage recognizes overlapping, empty-result runs and invalidates edits or inserted sources', () => {
    const run = { start: 0, end: 1, sources, includeHidden: false, suggestions: [] };
    assert.equal(rangeCoverage(chat, sources, [run]).status, 'done');
    assert.equal(rangeCoverage(chat, selectSources(chat, 0, 2, { includeHidden: true }), [run]).status, 'partial');
    const changed = structuredClone(chat); changed[1].mes = 'Изменено';
    assert.equal(rangeCoverage(changed, selectSources(changed, 0, 1), [run]).status, 'changed');
    assert.equal(rangeCoverage(chat, sources, []).status, 'new');
    const appended = [...chat, { mes: 'Следующая сцена', is_user: true }];
    assert.equal(rangeCoverage(appended, selectSources(appended, 0, 1), [run]).status, 'done');
});

test('rollback compares full record, tolerates key order and detects later manual edits', () => {
    assert.equal(canRestore({ content: 'a', key: ['a'], disable: true }, { disable: true, key: ['a'], content: 'a' }), true);
    assert.equal(canRestore({ content: 'a', key: ['b'] }, { content: 'a', key: ['a'] }), false);
    assert.equal(canRestore(null, { content: 'a' }), false);
});
