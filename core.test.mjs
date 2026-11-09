import test from 'node:test';
import assert from 'node:assert/strict';
import { historyStatus, resultPage } from './view-state.mjs';
import { sourceParagraphs } from './evidence.mjs';
import { analysisStatus, contextIdentity, selectSources, sourcesAreCurrent, validateSuggestions, entryLabels, rangeCoverage, canRestore } from './core.mjs';

const chat = [
    { mes: 'Мать научила меня зашивать раны.', name: 'Ая', is_user: true },
    { mes: 'Она уверенно наложила шов.', name: 'Рассказчик', swipe_id: 0 },
    { mes: 'Скрытая деталь', is_system: true },
];
const sources = selectSources(chat, 0, 2);

test('paragraph IDs are stable for LF/CRLF and preserve source text, markup and ordinary line breaks', () => {
    const source = { id: 13, text: '*Первый абзац.*\r\n\r\n  Второй\r\nстрокой.\r\n \r\nТретий.' };
    assert.deepEqual(sourceParagraphs(source), [{ sourceId: '13:1', text: '*Первый абзац.*' }, { sourceId: '13:2', text: '  Второй\r\nстрокой.' }, { sourceId: '13:3', text: 'Третий.' }]);
    assert.equal(sourceParagraphs({ id: 9, text: 'Без пустых строк' })[0].sourceId, '9:1');
});

test('reference evidence uses original text and authorship, rejects invented IDs without falling back to quotes', () => {
    const result = draft();
    result.suggestions[0].evidence = [{ sourceId: '1:1', quote: 'Модель изменила текст', messageId: 0, author: 'user' }];
    const [validated] = validateSuggestions(result, { sources });
    assert.equal(validated.evidence[0].quote, chat[1].mes);
    assert.equal(validated.evidence[0].messageId, 1);
    assert.equal(validated.evidence[0].author, 'model');
    assert.equal(validated.modelAuthored, true);
    for (const sourceId of ['1:2', '99:1', '01:1', '1:0', '__proto__', 1, null]) {
        result.suggestions[0].evidence = [{ sourceId, messageId: 0, quote: chat[0].mes }];
        assert.throws(() => validateSuggestions(result, { sources }), /ID абзаца/);
    }
});

test('result pages cap at 20, retain older runs and filter without changing stored data', () => {
    const runs = Array.from({ length: 45 }, (_, id) => ({ id, suggestions: id % 2 === 0 ? [{ status: id % 4 === 0 ? 'pending' : 'applied' }] : [] }));
    const snapshot = structuredClone(runs);
    assert.deepEqual(resultPage(runs).runs.map(run => run.id), Array.from({ length: 20 }, (_, i) => 44 - i));
    assert.equal(resultPage(runs, 'all', 1).runs.length, 20);
    assert.equal(resultPage(runs, 'all', 2).runs.length, 5);
    assert.equal(resultPage(runs, 'all', 99).page, 2);
    assert.equal(resultPage(runs, 'findings').total, 23);
    assert.equal(resultPage(runs, 'pending').total, 12);
    assert.equal(resultPage([], 'pending', 99).page, 0);
    assert.deepEqual(runs, snapshot);
    assert.equal(resultPage([{ suggestions: [], validationIssues: [{ title: 'Ошибка' }] }], 'findings').total, 1);
});

test('history distinguishes completed deletion, restoration and unfinished undo', () => {
    assert.equal(historyStatus({ kind: 'undo', status: 'applied', after: null }), 'Запись удалена');
    assert.equal(historyStatus({ kind: 'undo', status: 'applied', after: { content: 'Прежде' } }), 'Предыдущая версия восстановлена');
    assert.equal(historyStatus({ kind: 'undo', status: 'prepared', after: null }), 'Нужно проверить сохранение');
    assert.equal(historyStatus({ kind: 'apply', status: 'undone' }), 'Операция отменена');
});
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

test('partial evidence validation retains good proposals and reports shortened, reformatted or missing sources', () => {
    const result = draft();
    const bad = [
        { messageId: 0, quote: 'Мать [...] зашивать раны.' },
        { messageId: 0, quote: 'Мать научила\nменя зашивать раны.' },
        { messageId: 99, quote: 'Мать' },
    ];
    for (let index = 0; index < bad.length; index++) result.suggestions.push({ ...draft().suggestions[0], title: `Ошибка ${index}`, evidence: [bad[index]] });
    const issues = [];
    const valid = validateSuggestions(result, { sources, onEvidenceIssue: issue => issues.push(issue) });
    assert.equal(valid.length, 1);
    assert.equal(valid[0].title, 'Первая помощь');
    assert.deepEqual(issues.map(item => item.quote), bad.map(item => item.quote));
    assert.deepEqual(issues.map(item => item.messageId), [0, 0, 99]);
    assert.deepEqual(issues.map(item => item.title), ['Ошибка 0', 'Ошибка 1', 'Ошибка 2']);
    assert.match(issues[0].reason, /непрерывный дословный/);
    assert.match(issues[2].reason, /сообщение отсутствует/);
    assert.throws(() => validateSuggestions(result, { sources }), /Цитата отсутствует/);
});

test('separate verbatim excerpts and literal source ellipses remain valid', () => {
    const result = draft();
    result.suggestions[0].evidence = [{ messageId: 0, quote: 'Мать научила' }, { messageId: 0, quote: 'зашивать раны.' }];
    assert.equal(validateSuggestions(result, { sources })[0].evidence.length, 2);
    const literalSources = selectSources([{ mes: 'Слова [...] продолжение.', is_user: true }], 0, 0);
    result.suggestions[0].evidence = [{ messageId: 0, quote: 'Слова [...] продолжение.' }];
    assert.equal(validateSuggestions(result, { sources: literalSources }).length, 1);
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


test('analysis completion distinguishes no changes, incomplete output, refusal and contradictory statuses', () => {
    assert.equal(analysisStatus({status:'no_changes',reason:'No new facts',suggestions:[]}), 'no_changes');
    assert.equal(analysisStatus({status:'updated',suggestions:[{}]}), 'updated');
    for (const result of [{suggestions:[]},{status:'updated',suggestions:[]},{status:'no_changes',suggestions:[]},{status:'no_changes',reason:'Done',suggestions:[{}]},{status:'unable_to_analyze',reason:'Refusal',suggestions:[]}]) assert.throws(()=>analysisStatus(result));
});
