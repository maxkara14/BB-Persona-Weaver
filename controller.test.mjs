import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonController } from './controller.mjs';
import { rangeCoverage, selectSources } from './core.mjs';
import { apiBase, assertCompletionAllowed, listModels, requestAnalysis } from './connections.mjs';
import { CanonAutomation } from './automation.mjs';
import { analysisPrompt } from './prompt.mjs';
import { compileKey, parseKeys as parseKeysForTest } from './keys.mjs';

const config = { mode: 'current', timeout: 15, maxTokens: 1000, budget: 32000 };
const copy = value => structuredClone(value);
const regexKeys = ['/раны/iu', '/wounds/iu'];
const response = value => JSON.stringify({ ...value, suggestions: value.suggestions.map(item => ({ ...item, keywords: item.keywords ?? regexKeys })) });
function fixture() {
    let context = { identity: 'chat-a', persona: 'aya.png', personaName: 'Ая', chatName: 'История', book: 'Канон', description: 'Персона',
        chat: [{ mes: 'Мать научила меня зашивать раны.', is_user: true, name: 'Ая' }] };
    let book = { entries: { 99: { uid: 99, comment: 'Чужая запись', content: 'Сохранить', key: ['чужое'], extra: { intact: true } } } };
    const states = new Map(); let calls = 0, writes = 0;
    let answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Умеет зашивать раны.', reason: 'Прямое утверждение.', conflict: false,
        evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] };
    const host = {
        capture: () => ({ ...context }),
        loadState: async identity => copy(states.get(identity) ?? { version: 1, runs: [], history: [] }),
        saveState: async (identity, state) => { states.set(identity, copy(state)); },
        readBook: async () => copy(book), writeBook: async (name, next) => { writes++; book = copy(next); },
        makeEntry(data) { const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1;
            const entry = { uid, key: [], content: '', comment: '', constant: false, disable: false }; data.entries[uid] = entry; return entry; },
        countTokens: async () => 100, contextLimit: () => 32000, currentModel: () => 'test-current', profiles: () => [{ id: 'p', name: 'Test', model: 'test-profile' }],
        currentRequest: async () => { calls++; return response(answer); },
        profileRequest: async () => { calls++; return { content: response(answer) }; },
    };
    const controller = new CanonController(host);
    return { host, controller, states, get context() { return context; }, set context(next) { context = next; },
        get book() { return book; }, set book(next) { book = next; }, get calls() { return calls; }, get writes() { return writes; },
        set answer(next) { answer = next; },
        analyze: (extra = {}) => controller.analyze({ start: 0, end: 0, includeHidden: false, config, key: '', ...extra }),
    };
}

test('Unicode chat survives analysis, JSON repair, evidence validation, book write, key matching and undo', async () => {
    for (const mode of ['current', 'profile']) {
        const f = fixture();
        const scene = 'Мать научила меня зашивать раны. 👩‍💻'.replaceAll(' ', '\u2800');
        f.context.chat[0].mes = scene;
        let sent;
        const reply = prompt => {
            sent = JSON.parse(prompt[1].content);
            const data = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Умеет\u2800зашивать\u3164раны. 👩‍💻',
                reason: 'Из\u2800сцены.', conflict: false, keywords: ['/зашивать\\s+раны/iu', '/stitch\\s+wounds/iu'], evidence: [{ sourceId: '0:1' }] }] };
            return '{\u2800' + JSON.stringify(data).slice(1);
        };
        f.host.currentRequest = async prompt => reply(prompt);
        f.host.profileRequest = async (_id, prompt) => ({ content: reply(prompt) });
        const before = copy(f.book);
        const { run } = await f.analyze({ config: { ...config, mode, profileId: 'p' } });
        assert.equal(sent.scene[0].paragraphs[0].text, scene);
        const suggestion = run.suggestions[0];
        assert.equal(suggestion.evidence[0].quote, scene);
        assert.equal(suggestion.content, 'Умеет зашивать раны. 👩‍💻');
        assert.equal(f.writes, 0);
        await f.controller.apply(run.id, suggestion.id);
        assert.equal(f.book.entries[100].content, suggestion.content);
        assert.equal(compileKey(f.book.entries[100].key[0]).test(scene), true);
        assert.equal(f.context.chat[0].mes, scene);
        await f.controller.undo(f.states.get('chat-a').history[0].id);
        assert.deepEqual(f.book, before);
    }
});

test('Unicode section updates preserve old manual keys and restore original text on undo', async () => {
    const f = fixture();
    const oldKey = '/manual\\s+key/iu';
    f.book.entries[1] = { uid: 1, key: [oldKey], comment: 'Навыки Ая', content: 'Старый\u2800текст.',
        personaCanon: { version: 1, section: true, persona: 'aya.png', category: 'skills', origins: [] } };
    const before = copy(f.book);
    f.answer = { suggestions: [{ target: '1', category: 'skills', title: 'Навыки', content: 'Старый\u2800текст.\nНовый\u2800факт.',
        reason: 'Из сцены.', conflict: false, keywords: ['/зашивать\\s+раны/iu', '/stitch\\s+wounds/iu'], evidence: [{ sourceId: '0:1' }] }] };
    const { run } = await f.analyze();
    assert.deepEqual(f.book, before, 'analysis must not rewrite stored text');
    await f.controller.apply(run.id, run.suggestions[0].id);
    assert.equal(f.book.entries[1].content, 'Старый текст.\nНовый факт.');
    assert.equal(f.book.entries[1].key[0], oldKey);
    await f.controller.undo(f.states.get('chat-a').history[0].id);
    assert.deepEqual(f.book, before);
});

test('activity exposes stages and range, then clears after completion or cancellation', async () => {
    const f = fixture();
    const activities = [];
    const unsubscribe = f.controller.subscribe(() => activities.push(copy(f.controller.activity)));
    // A broken view must not abort the operation.
    f.controller.subscribe(() => { throw new Error('detached view'); });
    await f.analyze();
    assert.deepEqual(activities.map(item => item?.stage ?? null), ['Подготовка запроса…', 'Ожидание ответа модели…', 'Проверка ответа…', null]);
    assert.ok(activities.slice(0, -1).every(item => item.start === 0 && item.end === 0));
    assert.equal(f.controller.busy, false);
    unsubscribe();
    const previous = activities.length;
    f.controller.subscribe(() => { if (f.controller.activity?.stage === 'Подготовка запроса…') f.controller.cancel(); });
    await assert.rejects(() => f.analyze({ force: true }), /отменён/);
    assert.equal(f.calls, 1, 'Cancelling preparation must not reach the model');
    assert.equal(f.controller.activity, null);
    assert.equal(f.controller.abort, null);
    assert.equal(activities.length, previous, 'Detached subscribers must not receive updates');
    assert.equal(f.states.get('chat-a').runs.length, 1, 'Cancelled run must not mark additional coverage');
});

test('full manual path: journal, editable suggestion, book write, replay prevention and undo', async () => {
    const f = fixture();
    const { run } = await f.analyze();
    assert.equal(f.writes, 0); assert.equal(f.states.get('chat-a').runs.length, 1);
    const suggestion = run.suggestions[0];
    await f.controller.edit(run.id, suggestion.id, { content: 'Исправленный текст.', label: 'general', keywords: 'шов, рана' });
    await f.controller.apply(run.id, suggestion.id);
    const entry = f.book.entries[100];
    assert.equal(entry.content, 'Исправленный текст.'); assert.equal(entry.personaCanon.origins[0].kind, 'general');
    assert.equal(entry.disable, false); assert.equal(entry.constant, false);
    assert.deepEqual(f.book.entries[99].extra, { intact: true });
    await assert.rejects(() => f.controller.apply(run.id, suggestion.id), /уже обработано/);
    assert.equal(f.writes, 1);
    const operation = f.states.get('chat-a').history[0];
    await f.controller.undo(operation.id);
    assert.equal(f.book.entries[100], undefined); assert.ok(f.book.entries[99]);
    assert.equal(f.states.get('chat-a').runs[0].suggestions[0].status, 'reverted');
});

test('empty successful analysis covers a scene; repeated analysis requires explicit force', async () => {
    const f = fixture(); f.answer = { status: 'no_changes', reason: 'No new facts.', suggestions: [] };
    await f.analyze();
    assert.equal((await f.analyze()).repeated, true); assert.equal(f.calls, 1);
    await f.analyze({ force: true }); assert.equal(f.calls, 2);
    assert.equal(rangeCoverage(f.context.chat, selectSources(f.context.chat, 0, 0), f.states.get('chat-a').runs).status, 'done');
});

function compressionFixture() {
    const f = fixture();
    for (const [uid, category] of [[1, 'skills'], [2, 'relationships']]) f.book.entries[uid] = { uid, comment: `${category} Ая`, content: `Подробный текст раздела ${category}. Сохранить все факты.`, key: ['/old/iu'], order: 777, constant: true, vectorized: true,
        personaCanon: { version: 1, section: true, persona: 'aya.png', category, origins: [{ id: 'old', kind: 'general' }] } };
    return f;
}

test('compression batches one request, retries one item, preserves other proposals and journals reversible content-only updates', async () => {
    const f = compressionFixture(); const requests = [];
    f.host.currentRequest = async prompt => {
        const data = JSON.parse(prompt[1].content); requests.push(data);
        assert.equal(data.scene, undefined);
        return JSON.stringify({ entries: data.entries.map(entry => ({ id: entry.id, content: `Кратко ${entry.id}, вариант ${requests.length}.` })) });
    };
    const before = copy(f.book.entries[1]);
    const proposals = await f.controller.compress({ ids: ['1', '2'], config, key: '' });
    assert.equal(requests.length, 1); assert.equal(requests[0].entries.length, 2); assert.equal(f.writes, 0);
    await f.controller.compress({ retryId: proposals[0].id, config, key: '' });
    assert.equal(requests[1].entries.length, 1); assert.equal(requests[1].entries[0].id, '1');
    assert.equal(f.states.get('chat-a').compressions[1].content, proposals[1].content);
    await f.controller.editCompression(proposals[0].id, { content: 'Ручная правка сжатия.' });
    await f.controller.applyCompression(proposals[0].id);
    assert.deepEqual(f.book.entries[1], { ...before, content: 'Ручная правка сжатия.' });
    const operation = f.states.get('chat-a').history[0]; assert.equal(operation.kind, 'compress');
    assert.equal(f.states.get('chat-a').compressions[0].status, 'applied');
    await f.controller.undo(operation.id);
    assert.deepEqual(f.book.entries[1], before);
    assert.equal(f.states.get('chat-a').compressions[0].status, 'reverted');
    await f.controller.editCompression(proposals[1].id, { status: 'rejected' });
    await assert.rejects(() => f.controller.applyCompression(proposals[1].id), /не готово/);
    assert.equal(Object.keys(f.book.entries).length, 3);
});

test('compression rejects invalid IDs, bad results, cancellation, insufficient budget and stale entries without writes', async () => {
    for (const entries of [[{ id: '9', content: 'Текст' }], [{ id: '1', content: '' }], [{ id: '1', content: 'A' }, { id: '1', content: 'B' }]]) {
        const f = compressionFixture(); f.host.currentRequest = async () => JSON.stringify({ entries });
        await assert.rejects(() => f.controller.compress({ ids: ['1'], config })); assert.equal(f.writes, 0); assert.equal(f.states.size, 0);
    }
    const f = compressionFixture(); let calls = 0;
    f.host.currentRequest = async () => { calls++; return '{"entries":[{"id":"1","content":"Кратко."}]}'; };
    await assert.rejects(() => f.controller.compress({ ids: ['99'], config }), /не найдена/);
    f.host.contextLimit = () => 0;
    await assert.rejects(() => f.controller.compress({ ids: ['1'], config }), /бюджет/);
    assert.equal(calls, 0); f.host.contextLimit = () => 32000;
    const [proposal] = await f.controller.compress({ ids: ['1'], config });
    f.book.entries[1].content = 'Изменено вручную';
    await assert.rejects(() => f.controller.applyCompression(proposal.id), /изменилась/);
    await assert.rejects(() => f.controller.compress({ retryId: proposal.id, config }), /изменилась/);
    f.host.currentRequest = async () => { f.controller.cancel(); return '{"entries":[{"id":"1","content":"Кратко."}]}'; };
    await assert.rejects(() => f.controller.compress({ ids: ['1'], config }), /отменён/);
    assert.equal(f.writes, 0);
});

test('compression survives lost acknowledgement and cannot undo over subsequent changes', async () => {
    const f = compressionFixture();
    f.host.currentRequest = async () => '{"entries":[{"id":"1","content":"Кратко."}]}';
    const [proposal] = await f.controller.compress({ ids: ['1'], config });
    const write = f.host.writeBook;
    f.host.writeBook = async (...args) => { await write(...args); throw new Error('Ответ потерян'); };
    await assert.rejects(() => f.controller.applyCompression(proposal.id));
    const operation = f.states.get('chat-a').history[0]; assert.equal(operation.status, 'prepared');
    f.host.writeBook = write; await f.controller.recover(operation.id);
    assert.equal(f.writes, 1); assert.equal(f.states.get('chat-a').compressions[0].status, 'applied');
    f.book.entries[1].content = 'Поздняя ручная правка';
    await assert.rejects(() => f.controller.undo(operation.id), /изменилась/);
    assert.equal(f.book.entries[1].content, 'Поздняя ручная правка');
});

test('priority modes apply to new sections only, count persona sections and preserve updates', async () => {
    for (const [mode, value, expected] of [['manual', 0, [0, 0]], ['auto', 100, [1, 2]], ['reverse', 100, [30, 29]]]) {
        const f = fixture();
        const options = { ...config, entryOrderMode: mode, entryOrderValue: value, entryReverseStart: 30 };
        const first = (await f.analyze({ config: options })).run;
        await f.controller.apply(first.id, first.suggestions[0].id);
        assert.equal(f.book.entries[100].order, expected[0]);
        const fact = { target: null, category: 'relationships', title: 'Связи', content: 'Новый факт.', reason: 'Факт.', conflict: false, evidence: [{ sourceId: '0:1' }] };
        f.answer = { suggestions: [fact] };
        const second = (await f.analyze({ force: true, config: options })).run;
        await f.controller.apply(second.id, second.suggestions[0].id);
        assert.equal(f.book.entries[101].order, expected[1]);
        f.book.entries[100].order = 777;
        f.answer = { suggestions: [{ ...fact, target: '100', category: 'skills' }] };
        const update = (await f.analyze({ force: true, config: options })).run;
        await f.controller.apply(update.id, update.suggestions[0].id);
        assert.equal(f.book.entries[100].order, 777);
    }
});

test('paragraph references pass from the prompt through review into saved origins without copied quotations', async () => {
    const f = fixture();
    const original = '*Она обматывает полосу. Пальцы на рукояти катаны белеют.*';
    f.context.chat[0].mes = 'Первый абзац.\n\n' + original;
    f.host.currentRequest = async prompt => {
        const data = JSON.parse(prompt[1].content);
        assert.equal(data.scene[0].text, undefined, 'Do not send duplicate full text alongside paragraphs');
        assert.deepEqual(data.scene[0].paragraphs[1], { sourceId: '0:2', text: original });
        return response({ suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Умеет перевязывать раны.', reason: 'Показано.', conflict: false,
            evidence: [{ sourceId: '0:2' }] }] });
    };
    const { run } = await f.analyze();
    assert.equal(run.suggestions[0].evidence[0].quote, original);
    await f.controller.apply(run.id, run.suggestions[0].id);
    assert.equal(f.book.entries[100].personaCanon.origins[0].evidence[0].sourceId, '0:2');
    assert.equal(f.book.entries[100].personaCanon.origins[0].evidence[0].quote, original);
    f.host.currentRequest = async () => { f.context.chat[0].mes = 'Изменено во время запроса'; return '{"status":"no_changes","reason":"No new facts.","suggestions":[]}'; };
    await assert.rejects(() => f.analyze({ force: true }), /изменились во время анализа/);
});

test('event preference reaches actual analysis requests with a custom prompt and complete existing section', async () => {
    const f = fixture(); const requests = [];
    f.book.entries[7] = { uid: 7, comment: 'Отношения Ая', content: 'Сабуро: знакомый.\n\nРэн: наставница.', key: ['/ren/iu'], personaCanon: { version: 1, persona: 'aya.png', category: 'relationships' } };
    f.host.currentRequest = async prompt => { requests.push(prompt); return '{"status":"no_changes","reason":"No new facts.","suggestions":[]}'; };
    await f.analyze({ config: { ...config, prompt: 'Custom instructions' } });
    await f.analyze({ force: true, config: { ...config, prompt: 'Custom instructions', saveEvents: true } });
    assert.match(requests[0][0].content, /PERSONA FACTS ONLY, NO PLOT CHRONICLE/);
    assert.match(requests[1][0].content, /SAVE SIGNIFICANT PERSONAL EVENTS/);
    assert.doesNotMatch(requests[1][0].content, /PERSONA FACTS ONLY, NO PLOT CHRONICLE/);
    for (const prompt of requests) {
        assert.ok(prompt[0].content.startsWith('Custom instructions'));
        assert.match(prompt[0].content, /coherent edited version of that whole section/);
        assert.match(prompt[0].content, /Preserve ALL previously established facts/);
        assert.equal(JSON.parse(prompt[1].content).entries.find(entry => entry.id === '7').content, f.book.entries[7].content);
    }
});

test('all six categories create fixed persona sections even when the model supplies topic titles', async () => {
    const f = fixture();
    const titles = { appearance: 'Внешность Ая', habits: 'Привычки Ая', skills: 'Навыки Ая', history: 'Биография Ая', values: 'Ценности Ая', relationships: 'Отношения Ая' };
    f.answer = { suggestions: Object.keys(titles).map(category => ({ target: null, category, title: 'Произвольный NPC или приём', content: `Факт ${category}.`, reason: 'Факт.', conflict: false,
        evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] })) };
    const { run } = await f.analyze();
    for (const suggestion of run.suggestions) {
        assert.equal(suggestion.title, titles[suggestion.category]);
        await f.controller.apply(run.id, suggestion.id);
    }
    const entries = Object.values(f.book.entries).filter(entry => entry.personaCanon);
    assert.equal(entries.length, 6);
    assert.deepEqual(entries.map(entry => entry.comment).sort(), Object.values(titles).sort());
    assert.ok(entries.every(entry => entry.personaCanon.section === true));
    assert.equal(f.book.entries[99].content, 'Сохранить');
});

test('one legacy relationship entry becomes the shared section in place with old people, keys, flags and undo intact', async () => {
    const f = fixture();
    const legacy = { uid: 7, comment: 'Сабуро Миура', content: 'Сабуро Миура: помогла ему в бою.', key: ['/сабуро/iu'], constant: true,
        vectorized: true, excludeRecursion: true, preventRecursion: true, extra: 'keep', personaCanon: { version: 1, persona: 'aya.png', category: 'relationships', origins: [{ id: 'old', kind: 'general' }] } };
    f.book.entries[7] = copy(legacy);
    let sent;
    f.host.currentRequest = async prompt => {
        sent = JSON.parse(prompt[1].content);
        return response({ suggestions: [{ target: '7', category: 'relationships', title: 'Рэн', content: `${legacy.content}\n\nРэн: познакомилась на отборе.`, reason: 'Новое знакомство.', conflict: false,
            keywords: ['/рэн/iu', '/ren/iu'], evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] });
    };
    const { run } = await f.analyze();
    assert.deepEqual(sent.sections.find(section => section.category === 'relationships'), { category: 'relationships', title: 'Отношения Ая', target: '7' });
    assert.equal(sent.entries.find(entry => entry.id === '7').content, legacy.content);
    assert.equal(run.suggestions[0].before, legacy.content);
    await f.controller.apply(run.id, run.suggestions[0].id);
    const saved = f.book.entries[7];
    assert.equal(Object.keys(f.book.entries).length, 2);
    assert.equal(saved.comment, 'Отношения Ая');
    assert.equal(saved.content, `${legacy.content}\n\nРэн: познакомилась на отборе.`);
    assert.deepEqual(saved.key, ['/сабуро/iu', '/рэн/iu', '/ren/iu']);
    for (const field of ['constant', 'vectorized', 'excludeRecursion', 'preventRecursion', 'extra']) assert.equal(saved[field], legacy[field]);
    assert.deepEqual(saved.personaCanon.origins[0], legacy.personaCanon.origins[0]);
    assert.equal(saved.personaCanon.origins.length, 2);
    await f.controller.undo(f.states.get('chat-a').history[0].id);
    assert.deepEqual(f.book.entries[7], legacy);
});

test('section updates cannot create a second entry, target another category, or split one category into multiple proposals', async () => {
    const f = fixture();
    const { run } = await f.analyze(); await f.controller.apply(run.id, run.suggestions[0].id);
    const base = { target: null, category: 'skills', title: 'Другой навык', content: 'Факт.', reason: 'Факт.', conflict: false, evidence: [{ messageId: 0, quote: 'зашивать раны' }] };
    f.answer = { suggestions: [base] };
    await assert.rejects(() => f.analyze({ force: true }), /неверную цель/);
    f.answer = { suggestions: [{ ...base, target: '100', category: 'relationships' }] };
    await assert.rejects(() => f.analyze({ force: true }), /неверную цель/);
    f.answer = { suggestions: [{ ...base, target: '100' }, { ...base, target: '100', title: 'Ещё навык' }] };
    await assert.rejects(() => f.analyze({ force: true }), /одной записи/);
    const fresh = fixture();
    fresh.answer = { suggestions: [base, { ...base, title: 'Ещё навык' }] };
    await assert.rejects(() => fresh.analyze(), /один общий обновлённый текст/);
    assert.equal(f.writes, 1); assert.equal(f.states.get('chat-a').runs.length, 1);
    assert.equal(fresh.writes, 0); assert.equal(fresh.states.size, 0);
});

test('late section creation and uncertain-save recovery cannot produce a duplicate section', async () => {
    const f = fixture(); const { run } = await f.analyze();
    const duplicate = { uid: 50, comment: 'Навыки Ая', content: 'Из другой вкладки.', key: ['/other/iu'], personaCanon: { version: 1, persona: 'aya.png', category: 'skills' } };
    f.book.entries[50] = copy(duplicate);
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id), /Раздел уже создан/);
    assert.equal(f.writes, 0);
    delete f.book.entries[50];
    const persist = f.host.saveState;
    f.host.saveState = async (identity, state) => { await persist(identity, state); if (state.history.some(item => item.status === 'prepared')) f.book.entries[50] = copy(duplicate); };
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id), /Другой экземпляр раздела/);
    assert.equal(f.writes, 0);
    assert.equal(f.states.get('chat-a').history[0].status, 'prepared');
    await assert.rejects(() => f.controller.recover(f.states.get('chat-a').history[0].id), /Другой экземпляр раздела/);
});

test('multiple legacy entries require explicit consolidation before calling the model', async () => {
    const f = fixture();
    for (const uid of [1, 2]) f.book.entries[uid] = { uid, comment: `NPC ${uid}`, content: `Факт ${uid}`, personaCanon: { version: 1, persona: 'aya.png', category: 'relationships' } };
    await assert.rejects(() => f.analyze(), /несколько старых записей/);
    assert.equal(f.calls, 0); assert.equal(f.writes, 0);
    assert.equal(f.book.entries[1].content, 'Факт 1'); assert.equal(f.book.entries[2].content, 'Факт 2');
});

test('pending topic proposals from older versions must be analyzed again before writing', async () => {
    const f = fixture(); const { run } = await f.analyze();
    delete f.controller.states.get('chat-a').runs[0].sectionVersion;
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id), /до перехода на записи по разделам/);
    assert.equal(f.writes, 0);
});

test('new custom categories require manual creation, can be renamed and are reused with full context', async () => {
    const f = fixture();
    const base = { target: null, category: 'custom', categoryName: 'Страхи', categoryReason: 'Несколько связанных страхов и способов справляться.', title: 'Страх темноты', content: 'Боится темноты.', reason: 'Факт.', conflict: false,
        keywords: ['/страх/iu', '/fear/iu'], evidence: [{ messageId: 0, quote: 'зашивать раны' }] };
    f.answer = { suggestions: [base] };
    const { run } = await f.analyze(); const suggestion = run.suggestions[0];
    assert.equal(suggestion.title, 'Страхи Ая');
    await assert.rejects(() => f.controller.apply(run.id, suggestion.id, { automatic: true }), /ручного подтверждения/);
    assert.equal(f.writes, 0);
    await f.controller.edit(run.id, suggestion.id, { content: 'Исправленный текст о страхе темноты.' });
    await f.controller.configureCategory(run.id, suggestion.id, { name: 'Страхи и тревоги' });
    await f.controller.apply(run.id, suggestion.id);
    const saved = f.book.entries[100];
    assert.equal(saved.comment, 'Страхи и тревоги Ая');
    assert.equal(saved.content, 'Исправленный текст о страхе темноты.');
    assert.equal(saved.personaCanon.categoryName, 'Страхи и тревоги');
    const category = saved.personaCanon.category;
    f.host.currentRequest = async prompt => {
        const data = JSON.parse(prompt[1].content);
        assert.equal(data.sections.find(section => section.category === category).target, '100');
        assert.equal(data.entries.find(entry => entry.id === '100').content, saved.content);
        return response({ suggestions: [{ ...base, category, target: '100', content: 'Боится темноты. Успокаивается при свете.' }] });
    };
    const next = (await f.analyze({ force: true })).run;
    assert.equal(next.suggestions[0].requiresCategoryApproval, undefined);
    await f.controller.apply(next.id, next.suggestions[0].id, { automatic: true });
    assert.equal(Object.keys(f.book.entries).length, 2);
    assert.equal(f.book.entries[100].comment, 'Страхи и тревоги Ая');
});

test('custom proposals can be routed into an existing section with its prior content and keys', async () => {
    const f = fixture(); const first = (await f.analyze()).run; await f.controller.apply(first.id, first.suggestions[0].id);
    const before = copy(f.book.entries[100]);
    f.answer = { suggestions: [{ target: null, category: 'custom', categoryName: 'Лечение', categoryReason: 'Отдельная тема.', title: 'Тема', content: 'Умеет накладывать повязки.', reason: 'Факт.', conflict: false,
        keywords: ['/повязк/iu', '/bandage/iu'], evidence: [{ messageId: 0, quote: 'зашивать раны' }] }] };
    const { run } = await f.analyze({ force: true }); const suggestion = run.suggestions[0];
    await assert.rejects(() => f.controller.configureCategory(run.id, suggestion.id, { name: ' ПрИвыЧки ' }), /стандартная категория/);
    await f.controller.configureCategory(run.id, suggestion.id, { destination: 'skills' });
    const draft = f.controller.states.get('chat-a').runs.at(-1).suggestions[0];
    assert.equal(draft.before, before.content);
    assert.equal(draft.content, before.content + '\n\nУмеет накладывать повязки.');
    await assert.rejects(() => f.controller.apply(run.id, suggestion.id, { automatic: true }), /ручного подтверждения/);
    await f.controller.apply(run.id, suggestion.id);
    assert.equal(f.book.entries[100].comment, 'Навыки Ая');
    assert.deepEqual(f.book.entries[100].key, [...before.key, '/повязк/iu', '/bandage/iu']);
    assert.equal(Object.keys(f.book.entries).length, 2);
});

test('automatic analysis queues custom categories and exact duplicate custom names are rejected', async () => {
    const f = fixture();
    const base = { target: null, category: 'custom', categoryName: 'Страхи', categoryReason: 'Отдельная тема.', title: 'Тема', content: 'Факт.', reason: 'Факт.', conflict: false,
        evidence: [{ messageId: 0, quote: 'зашивать раны' }] };
    f.answer = { suggestions: [base] };
    const options = { ...config, autoEnabled: true, autoContext: 'chat-a', autoTrigger: 'messages', autoMessages: 1, autoSave: true };
    const auto = new CanonAutomation(f.controller, { ...f.host, settings: () => options, getKey: () => '', isGenerating: () => false });
    await auto.tick();
    assert.equal(f.writes, 0);
    const run = f.states.get('chat-a').runs[0];
    assert.equal(run.suggestions[0].status, 'pending');
    await f.controller.apply(run.id, run.suggestions[0].id);
    f.answer = { suggestions: [{ ...base, categoryName: '  СТРАХИ  ' }] };
    await assert.rejects(() => f.analyze({ force: true }), /категория уже существует/);
    f.answer = { suggestions: [{ ...base, category: 'custom:invented' }] };
    await assert.rejects(() => f.analyze({ force: true }), /Некорректная категория/);
});

test('request errors, cancellation and invalid JSON never mark the scene processed', async () => {
    for (const request of [async () => { throw new Error('provider'); }, async () => 'not json']) {
        const f = fixture(); f.host.currentRequest = request;
        await assert.rejects(() => f.analyze()); assert.equal(f.states.size, 0); assert.equal(f.writes, 0);
    }
    const f = fixture();
    f.host.currentRequest = async () => { f.controller.cancel(); return '{"status":"no_changes","reason":"No new facts.","suggestions":[]}'; };
    await assert.rejects(() => f.analyze(), /отменён/); assert.equal(f.states.size, 0);
});

test('missing and invalid sources stay editable, autosave skips them, manual acceptance works', async () => {
    for (const evidence of [undefined, [], [{sourceId:'99:1'}]]) {
        const f=fixture(); f.answer={suggestions:[{target:null,category:'skills',title:'Навыки',content:'Факт',reason:'Факт',conflict:false,evidence}]};
        const options={...config,autoEnabled:true,autoMessages:1,autoSave:true};
        const auto=new CanonAutomation(f.controller,{...f.host,settings:()=>options,getKey:()=>'',isGenerating:()=>false});
        await auto.tick();
        const run=f.states.get('chat-a').runs[0]; assert.equal(run.suggestions.length,1);
        const item=run.suggestions[0]; assert.ok(item.evidenceIssue); assert.deepEqual(item.evidence,[]);
        assert.equal(f.writes,0); assert.equal(auto.blocked,false);
        await assert.rejects(f.controller.apply(run.id,item.id,{automatic:true}),/ручной/);
        const count=f.calls; await auto.tick(); assert.equal(f.calls,count);
        const reloaded=new CanonController(f.host); assert.ok((await reloaded.state(f.context)).runs[0].suggestions[0].evidenceIssue);
        await reloaded.apply(run.id,item.id); assert.equal(f.writes,1);
        await reloaded.undo(f.states.get('chat-a').history[0].id); assert.equal(f.book.entries[100],undefined);
    }
});

test('more than twelve valid source references are accepted without warnings', async () => {
    const f=fixture(); f.context.chat[0].mes=Array.from({length:20},(_,i)=>'Факт '+i).join('\n\n');
    f.answer={suggestions:[{target:null,category:'skills',title:'Навыки',content:'Факт',reason:'Факт',conflict:false,evidence:Array.from({length:20},(_,i)=>({sourceId:'0:'+(i+1)}))}]};
    const {run}=await f.analyze(); assert.equal(run.suggestions[0].evidence.length,20); assert.equal(run.suggestions[0].evidenceIssue,undefined);
    await f.controller.apply(run.id,run.suggestions[0].id,{automatic:true}); assert.equal(f.writes,1);
    f.answer={suggestions:[{target:'100',category:'skills',title:'Навыки',content:'Дополнение',reason:'Факт',conflict:false,evidence:[{sourceId:'0:1'},{sourceId:'99:1'},{sourceId:'0:2'}]}]};
    const mixed=await f.analyze({force:true}); assert.equal(mixed.run.suggestions[0].evidence.length,2); assert.ok(mixed.run.suggestions[0].evidenceIssue);
});

test('navigation or source changes during analysis cannot save to the next context', async () => {
    for (const mutate of [f => { f.context = { ...f.context, identity: 'other' }; }, f => { f.context.chat[0].mes = 'Отредактировано'; }]) {
        const f = fixture(); f.host.currentRequest = async () => { mutate(f); return '{"status":"no_changes","reason":"No new facts.","suggestions":[]}'; };
        await assert.rejects(() => f.analyze()); assert.equal(f.states.size, 0);
    }
});

test('stale sources prevent application, including recovery after an uncertain request', async () => {
    const f = fixture(); const { run } = await f.analyze();
    f.host.writeBook = async () => { throw new Error('network'); };
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id));
    f.context.chat[0].mes = 'Другая версия';
    const operation = f.states.get('chat-a').history[0];
    await assert.rejects(() => f.controller.recover(operation.id), /Источники изменились/);
    assert.equal(f.book.entries[100], undefined);
});

test('lost server acknowledgement recovers a committed write without duplicates', async () => {
    const f = fixture(); const { run } = await f.analyze();
    const original = f.host.writeBook;
    f.host.writeBook = async (...args) => { await original(...args); throw new Error('lost acknowledgement'); };
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id));
    assert.equal(f.states.get('chat-a').history[0].status, 'prepared');
    f.host.writeBook = original;
    await f.controller.recover(f.states.get('chat-a').history[0].id);
    assert.equal(f.writes, 1); assert.equal(f.states.get('chat-a').history[0].status, 'applied');
    assert.equal(Object.keys(f.book.entries).length, 2);
});

test('failure to persist intent prevents external writes; failure to finalize is recoverable', async () => {
    const f = fixture(); const { run } = await f.analyze();
    const original = f.host.saveState;
    f.host.saveState = async () => { throw new Error('disk'); };
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id)); assert.equal(f.writes, 0);
    let calls = 0;
    f.host.saveState = async (...args) => { if (++calls === 2) throw new Error('disk'); return original(...args); };
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id)); assert.equal(f.writes, 1);
    f.host.saveState = original;
    await f.controller.recover(f.states.get('chat-a').history[0].id); assert.equal(f.writes, 1);
});

test('updating existing section preserves unrelated fields and multiple chat labels', async () => {
    const f = fixture(); const { run } = await f.analyze(); await f.controller.apply(run.id, run.suggestions[0].id);
    f.context = { ...f.context, identity: 'branch-b', chatName: 'Новая история' };
    f.answer = { suggestions: [{ target: '100', category: 'skills', title: 'Навыки', content: 'Умеет зашивать раны. Училась у матери.', reason: 'Происхождение навыка.', conflict: false,
        evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] };
    const second = (await f.analyze()).run;
    await f.controller.apply(second.id, second.suggestions[0].id);
    assert.equal(f.book.entries[100].personaCanon.origins.length, 2);
    assert.equal(f.book.entries[100].personaCanon.origins[0].context, 'chat-a');
    assert.equal(f.book.entries[100].personaCanon.origins[1].context, 'branch-b');
    assert.equal(f.states.get('chat-a').runs.length, 1); assert.equal(f.states.get('branch-b').runs.length, 1);
});

test('manual edits block update and rollback, including activation and keyword edits', async () => {
    const f = fixture(); const { run } = await f.analyze(); await f.controller.apply(run.id, run.suggestions[0].id);
    const operation = f.states.get('chat-a').history[0]; f.book.entries[100].key = ['ручная правка'];
    await assert.rejects(() => f.controller.undo(operation.id), /запись изменилась/);
    assert.deepEqual(f.book.entries[100].key, ['ручная правка']);
});

test('updating content preserves existing activation defaults and detects late edits', async () => {
    const f = fixture(); const { run } = await f.analyze(); await f.controller.apply(run.id, run.suggestions[0].id);
    f.book.entries[100].constant = true; f.book.entries[100].key = ['старый ключ', 'ещё ключ'];
    f.answer = { suggestions: [{ target: '100', category: 'skills', title: 'Навыки', content: 'Новый текст', reason: 'Уточнение', conflict: false,
        evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] };
    const update = (await f.analyze({ force: true })).run;
    assert.equal(update.suggestions[0].constant, true);
    assert.equal(update.suggestions[0].keywords, ['старый ключ', 'ещё ключ', ...regexKeys].join('\n'));
    await f.controller.apply(update.id, update.suggestions[0].id);
    assert.equal(f.book.entries[100].constant, true); assert.deepEqual(f.book.entries[100].key, ['старый ключ', 'ещё ключ', ...regexKeys]);
    const stale = (await f.analyze({ force: true })).run;
    f.book.entries[100].content = 'Ручная правка после анализа';
    await assert.rejects(() => f.controller.apply(stale.id, stale.suggestions[0].id), /изменена после анализа/);
    assert.equal(f.book.entries[100].content, 'Ручная правка после анализа');
});

test('provider non-JSON responses do not reveal response bodies in errors', async () => {
    const f = fixture();
    f.host.fetch = async () => new Response('private-value not json');
    await assert.rejects(() => requestAnalysis(f.host, { ...config, mode: 'custom', model: 'x', url: 'https://example.com' }, '', [], new AbortController()), error => !error.message.includes('private-value'));
    await assert.rejects(() => listModels({ url: 'https://example.com' }, '', new AbortController().signal, f.host.fetch), error => !error.message.includes('private-value'));
});

test('labels change without touching content, activation or other origins', async () => {
    const f = fixture(); const { run } = await f.analyze(); await f.controller.apply(run.id, run.suggestions[0].id);
    const before = copy(f.book.entries[100]);
    await f.controller.relabel('100', before.personaCanon.origins[0].id, 'general');
    const after = f.book.entries[100];
    assert.equal(after.personaCanon.origins[0].kind, 'general');
    for (const key of ['content', 'constant', 'disable', 'key']) assert.deepEqual(after[key], before[key]);
});

test('rejected proposals do not alter book; local drafts can finish after changing chats', async () => {
    const f = fixture(); const { run } = await f.analyze(); const context = f.context;
    f.context = { ...f.context, identity: 'other' };
    await f.controller.edit(run.id, run.suggestions[0].id, { content: 'Сохранённый черновик', status: 'rejected' }, context);
    assert.equal(f.states.get('chat-a').runs[0].suggestions[0].content, 'Сохранённый черновик');
    assert.equal(f.writes, 0); assert.equal(f.states.has('other'), false);
});

test('API URL normalization and model list support manual fallback without exposing body', async () => {
    assert.equal(apiBase('https://example.com/v1/chat/completions/'), 'https://example.com/v1');
    for (const url of ['ftp://example.com', 'https://user:password@example.com', 'https://example.com?key=secret']) assert.throws(() => apiBase(url));
    const signal = new AbortController().signal;
    const ids = await listModels({ url: 'https://example.com/v1' }, 'key', signal, async (url, init) => {
        assert.equal(url, 'https://example.com/v1/models'); assert.equal(init.headers.Authorization, 'Bearer key');
        return Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, {}] });
    });
    assert.deepEqual(ids, ['a', 'b']);
    await assert.rejects(() => listModels({ url: 'https://example.com' }, '', signal, async () => new Response('private provider response', { status: 401 })), /HTTP 401/);
});

test('all three connection modes dispatch explicitly and never fall back to current', async () => {
    const f = fixture();
    await f.analyze({ config: { ...config, mode: 'profile', profileId: 'p' } }); assert.equal(f.calls, 1);
    f.host.fetch = async (url, init) => {
        assert.equal(url, 'https://example.com/v1/chat/completions');
        assert.equal(init.headers.Authorization, 'Bearer private');
        assert.equal(JSON.parse(init.body).model, 'custom-model');
        return Response.json({ choices: [{ message: { content: '{"status":"no_changes","reason":"No new facts.","suggestions":[]}' } }] });
    };
    const custom = { ...config, mode: 'custom', model: 'custom-model', url: 'https://example.com/v1' };
    await f.analyze({ force: true, config: custom, key: 'private' });
    assert.equal(f.calls, 1); assert.equal(JSON.stringify([...f.states.values()]).includes('private'), false);
    f.host.fetch = async () => new Response('private', { status: 403 });
    await assert.rejects(() => f.analyze({ force: true, config: custom }), /HTTP 403/); assert.equal(f.calls, 1);
    await assert.rejects(() => f.analyze({ force: true, config: { ...config, mode: 'profile', profileId: 'missing' } }), /недоступен/);
    assert.equal(f.calls, 1);
});

test('timeout aborts transport and does not persist a run', async () => {
    const f = fixture();
    f.host.profileRequest = async (id, prompt, max, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    await assert.rejects(() => requestAnalysis(f.host, { ...config, mode: 'profile', profileId: 'p', timeout: 0.01 }, '', [], new AbortController()), /время ожидания/);
    assert.equal(f.states.size, 0);
});

test('unbound persona can be analyzed; book is created and bound only on first save', async () => {
    const f = fixture(); f.context = { ...f.context, book: '' }; f.book = { entries: {} };
    let created = 0;
    f.host.ensureBook = async () => { created++; f.context = { ...f.context, book: 'Auto book' }; return 'Auto book'; };
    const { run } = await f.analyze(); assert.equal(created, 0); assert.equal(f.writes, 0);
    await f.controller.apply(run.id, run.suggestions[0].id);
    assert.equal(created, 1); assert.equal(f.book.entries[0].content, 'Умеет зашивать раны.');
    assert.equal(f.states.get('chat-a').runs[0].book, 'Auto book');
});

test('entry options and generated activation keys reach the saved entry', async () => {
    const f = fixture();
    f.answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Швы', keywords: regexKeys, reason: 'Факт', conflict: false, evidence: [{ messageId: 0, quote: 'зашивать раны' }] }] };
    const { run } = await f.analyze({ config: { ...config, entryVectorized: true, entryExcludeRecursion: true, entryPreventRecursion: true } });
    await f.controller.apply(run.id, run.suggestions[0].id);
    const entry = f.book.entries[100];
    assert.deepEqual(entry.key, regexKeys); assert.equal(entry.vectorized, true);
    assert.equal(entry.excludeRecursion, true); assert.equal(entry.preventRecursion, true);
    assert.equal(entry.constant, false);
});

test('regex quantifiers survive generation, review and persistence as two complete keys', async () => {
    const f = fixture();
    const pair = [String.raw`/(?:^|[^\p{L}\p{N}_])ран\p{L}{1,3}(?=$|[^\p{L}\p{N}_])/iu`, '/wounds{1,3}/iu'];
    f.answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Швы', keywords: pair, reason: 'Факт', conflict: false, evidence: [{ messageId: 0, quote: 'зашивать раны' }] }] };
    const { run } = await f.analyze();
    await f.controller.apply(run.id, run.suggestions[0].id);
    assert.deepEqual(f.book.entries[100].key, pair);
});

test('invalid generated regex retains the finding but prevents coverage and book writes', async () => {
    const f = fixture();
    f.answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Швы', keywords: ['/[/iu', '/wounds/iu'], reason: 'Факт', conflict: false, evidence: [{ messageId: 0, quote: 'зашивать раны' }] }] };
    const { run } = await f.analyze();
    assert.match(run.suggestions[0].keywordIssue, /regex/);
    assert.equal(rangeCoverage(f.context.chat, selectSources(f.context.chat, 0, 0), [run]).covered, 0);
    await assert.rejects(() => f.controller.apply(run.id, run.suggestions[0].id), /исправьте ключи/);
    assert.equal(f.writes, 0);
});

test('one bad key pair preserves other findings; manual correction is validated before saving', async () => {
    const f = fixture();
    f.answer = { suggestions: [
        { target: null, category: 'skills', title: 'Навыки', content: 'Умеет зашивать раны.', reason: 'Факт', conflict: false, keywords: ['/раны/iu'], evidence: [{ sourceId: '0:1' }] },
        { target: null, category: 'history', title: 'Биография', content: 'Мать обучила её шитью.', reason: 'Факт', conflict: false, keywords: regexKeys, evidence: [{ sourceId: '0:1' }] },
    ] };
    const { run } = await f.analyze();
    const [bad, good] = run.suggestions;
    assert.equal(run.suggestions.length, 2);
    assert.ok(bad.keywordIssue); assert.equal(good.keywordIssue, undefined);
    await f.controller.apply(run.id, good.id);
    assert.equal(f.writes, 1);
    await assert.rejects(() => f.controller.apply(run.id, bad.id), /Навыки/);
    await f.controller.edit(run.id, bad.id, { keywords: '/one/iu' });
    await assert.rejects(() => f.controller.apply(run.id, bad.id), /исправьте ключи/);
    await f.controller.edit(run.id, bad.id, { keywords: regexKeys.join('\n') });
    assert.equal(f.states.get('chat-a').runs[0].suggestions[0].keywordIssue, undefined);
    await f.controller.apply(run.id, bad.id);
    assert.equal(f.writes, 2);
});

test('missing, string, extra, malformed and non-iu keys all remain repairable drafts', async () => {
    for (const keys of [undefined, '/ru/iu\n/en/iu', [], ['/ru/iu'], ['/a/iu','/b/iu','/c/iu'], ['/[/iu','/en/iu'], ['/ru/i','/en/iu']]) {
        const f = fixture();
        f.host.currentRequest = async () => JSON.stringify({ suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Швы', reason: 'Факт', conflict: false, keywords: keys, evidence: [{ sourceId: '0:1' }] }] });
        const { run } = await f.analyze();
        assert.ok(run.suggestions[0].keywordIssue);
        assert.equal(f.writes, 0);
    }
});

test('key-only regeneration uses each selected transport and preserves finding, evidence and inherited keys', async () => {
    for (const mode of ['current', 'profile', 'custom']) {
        const f = fixture();
        f.book.entries[1] = { uid: 1, comment: 'Навыки Ая', content: 'Старый факт', key: ['ручной ключ'], personaCanon: { version: 1, section: true, category: 'skills', persona: 'aya.png', origins: [] } };
        f.answer = { suggestions: [{ target: '1', category: 'skills', title: 'Навыки', content: 'Умеет зашивать раны.', reason: 'Факт', conflict: false, keywords: [], evidence: [{ sourceId: '0:1' }] }] };
        const { run } = await f.analyze();
        const finding = run.suggestions[0];
        let sent, requests = 0;
        const reply = prompt => { requests++; sent = JSON.parse(prompt[1].content); return JSON.stringify({ keywords: ['/зашивать\\s+раны/iu','/stitch\\s+wounds/iu'], content: 'Ignore this rewrite' }); };
        f.host.currentRequest = async prompt => reply(prompt);
        f.host.profileRequest = async (_id, prompt) => ({ content: reply(prompt) });
        f.host.fetch = async (_url, request) => ({ ok: true, json: async () => ({ choices: [{ message: { content: reply(JSON.parse(request.body).messages) } }] }) });
        await f.controller.regenerateKeys(run.id, finding.id, { config: { ...config, mode, profileId: 'p', url: 'https://example.invalid/v1', model: 'test' }, key: '' });
        const repaired = f.states.get('chat-a').runs[0].suggestions[0];
        assert.equal(requests, 1); assert.deepEqual(sent, { title: finding.title, content: finding.content });
        assert.equal(repaired.keywordIssue, undefined);
        assert.equal(repaired.content, finding.content); assert.deepEqual(repaired.evidence, finding.evidence);
        assert.equal(parseKeysForTest(repaired.keywords)[0], 'ручной ключ');
        assert.ok(compileKey(parseKeysForTest(repaired.keywords)[1]).test('зашивать\u2800раны'));
        assert.equal(f.writes, 0);
        await f.controller.apply(run.id, finding.id);
        assert.equal(f.book.entries[1].key[0], 'ручной ключ');
    }
});

test('failed, cancelled and stale key regeneration preserves the draft without writes', async () => {
    for (const failure of ['bad JSON', 'bad keys', 'cancel', 'navigate', 'source', 'budget']) {
        const f = fixture();
        f.answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки', content: 'Швы', reason: 'Факт', conflict: false, keywords: [], evidence: [{ sourceId: '0:1' }] }] };
        const { run } = await f.analyze();
        const before = copy(f.states.get('chat-a'));
        let calls = 0;
        if (failure === 'budget') f.host.countTokens = async () => 50000;
        f.host.currentRequest = async () => {
            calls++;
            if (failure === 'cancel') f.controller.cancel();
            if (failure === 'navigate') f.context = { ...f.context, identity: 'another-chat' };
            if (failure === 'source') f.context.chat[0].mes += 'Changed';
            return failure === 'bad JSON' ? 'invalid' : JSON.stringify({ keywords: failure === 'bad keys' ? [] : regexKeys });
        };
        await assert.rejects(() => f.controller.regenerateKeys(run.id, run.suggestions[0].id, { config, key: '' }));
        assert.deepEqual(f.states.get('chat-a'), before);
        assert.equal(f.writes, 0);
        assert.equal(calls, failure === 'budget' ? 0 : 1);
    }
});

test('editable instructions keep the required output and evidence contract', () => {
    const prompt = analysisPrompt({ personaName: 'Ая', description: '' }, [], [], 'Краткие записи и точные ключи.');
    assert.ok(prompt[0].content.startsWith('Краткие записи и точные ключи.'));
    assert.ok(prompt[0].content.includes('keywords')); assert.ok(prompt[0].content.includes('evidence'));
});

test('automation respects global enablement, threshold, busy state and avoids repeat generation', async () => {
    const f = fixture(); let generating = false;
    const options = { ...config, autoEnabled: false, autoContext: 'other', autoTrigger: 'messages', autoMessages: 1, autoSave: true };
    const auto = new CanonAutomation(f.controller, { ...f.host, settings: () => options, getKey: () => '', isGenerating: () => generating });
    await auto.tick(); assert.equal(f.calls, 0);
    options.autoEnabled = true; generating = true; await auto.tick(); assert.equal(f.calls, 0);
    generating = false; options.autoMessages = 2; await auto.tick(); assert.equal(f.calls, 0);
    options.autoTrigger = 'tokens'; options.autoTokens = 100;
    await auto.tick(); assert.equal(f.calls, 1); assert.equal(f.writes, 1);
    await auto.tick(); assert.equal(f.calls, 1);
});

test('automation failure blocks retries without marking coverage; manual review mode does not write', async () => {
    const f = fixture();
    const options = { ...config, autoEnabled: true, autoContext: 'chat-a', autoTrigger: 'messages', autoMessages: 1, autoSave: false };
    const auto = new CanonAutomation(f.controller, { ...f.host, settings: () => options, getKey: () => '', isGenerating: () => false });
    f.host.currentRequest = async () => { throw new Error('unavailable'); };
    // The automation host dispatches through the controller's original host.
    await auto.tick(); assert.equal(auto.blocked, true); assert.equal(f.states.size, 0);
    auto.resume(); f.host.currentRequest = async () => '{"status":"no_changes","reason":"No new facts.","suggestions":[]}'; await auto.tick();
    assert.equal(f.states.get('chat-a').runs.length, 1); assert.equal(f.writes, 0);
});

test('partial autosave reports confirmed, pending and uncertain operations separately', async () => {
    const f = fixture(); const notices = [];
    f.answer = { suggestions: ['skills', 'history', 'values'].map(category => ({ target: null, category, title: category, content: category,
        reason: 'Факт', conflict: false, evidence: [{ messageId: 0, quote: 'зашивать раны' }] })) };
    const original = f.host.writeBook; let writes = 0;
    f.host.writeBook = async (...args) => { if (++writes === 2) throw new Error('Сбой записи'); return original(...args); };
    const options = { ...config, autoEnabled: true, autoContext: 'chat-a', autoTrigger: 'messages', autoMessages: 1, autoSave: true };
    const auto = new CanonAutomation(f.controller, { ...f.host, settings: () => options, getKey: () => '', isGenerating: () => false, notify: event => notices.push(event) });
    await auto.tick();
    assert.deepEqual(notices.map(event => event.type), ['started', 'failed']);
    assert.equal(notices[1].saved, 1); assert.equal(notices[1].uncertain, 1); assert.equal(notices[1].pending, 1);
    await auto.tick(); assert.equal(notices.length, 2, 'Blocked errors do not spam');
});

test('lost acknowledgement is reported as uncertain, never as confirmed saved', async () => {
    const f = fixture(); const notices = []; const original = f.host.writeBook;
    f.host.writeBook = async (...args) => { await original(...args); throw new Error('Ответ потерян'); };
    const options = { ...config, autoEnabled: true, autoContext: 'chat-a', autoTrigger: 'messages', autoMessages: 1, autoSave: true };
    const auto = new CanonAutomation(f.controller, { ...f.host, settings: () => options, getKey: () => '', isGenerating: () => false, notify: event => notices.push(event) });
    await auto.tick(); assert.equal(notices[1].type, 'failed'); assert.equal(notices[1].saved, 0);
    assert.equal(notices[1].uncertain, 1); assert.equal(notices[1].pending, 0);
    assert.ok(f.book.entries[100], 'Server write may have succeeded');
});


test('incomplete empty and refused analyses never create coverage and pause automatic retries', async () => {
    for (const answer of [{suggestions:[]},{status:'unable_to_analyze',reason:'Cannot comply',suggestions:[]}]) {
        const f=fixture(); f.host.currentRequest=async()=>JSON.stringify(answer);
        await assert.rejects(f.analyze());
        assert.equal(f.states.get('chat-a')?.runs.length ?? 0, 0);
        const auto=new CanonAutomation(f.controller,{...f.host,settings:()=>({...config,autoEnabled:true,autoContext:'chat-a',autoMessages:1}),getKey:()=>'',isGenerating:()=>false});
        await auto.tick(); assert.equal(auto.blocked,true); const calls=f.calls; await auto.tick(); assert.equal(f.calls,calls);
    }
});

test('provider refusal flags are rejected even with valid-looking no_changes content', () => {
    for (const data of [{choices:[{finish_reason:'content_filter'}]},{choices:[{message:{refusal:'blocked',content:'{}'}}]},{stop_reason:'refusal'}]) assert.throws(()=>assertCompletionAllowed(data),/отказе/);
    assert.doesNotThrow(()=>assertCompletionAllowed({choices:[{finish_reason:'stop',message:{content:'{}'}}]}));
});

test('coverage survives controller reload, navigation, book changes, edits and swipes without losing the journal', async () => {
    const f=fixture(); f.context.chat.push({mes:'Продолжение',name:'Рассказчик',swipe_id:0});
    f.answer={status:'no_changes',reason:'Nothing new',suggestions:[]};
    await f.analyze({end:1});
    const controller=new CanonController(f.host);
    const check=async()=>rangeCoverage(f.context.chat,selectSources(f.context.chat,0,1),(await controller.state(f.context)).runs);
    assert.equal((await check()).status,'done');
    const original=copy(f.context);
    f.context={...f.context,identity:'other-chat'};assert.equal((await check()).status,'new');
    f.context={...copy(original),book:'Другая книга',chatName:'Переименован'};assert.equal((await check()).status,'done');
    f.context.chat[1].swipe_id=1;assert.equal((await check()).status,'changed');
    f.context=copy(original);f.context.chat[0].mes='Изменено';assert.equal((await check()).status,'changed');
    assert.equal((await controller.state(f.context)).runs.length,1);
    f.context=copy(original);assert.equal((await check()).status,'done');
});
