import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonAutomation } from './automation.mjs';
import { showAutomationNotice } from './notifications.mjs';

function fixture() {
    const context = { identity: 'chat', book: 'Book', chat: [{ mes: 'A fact', is_user: true }] };
    const config = { autoEnabled: true, autoContext: 'chat', autoTrigger: 'messages', autoMessages: 1, autoSave: true };
    const notices = [];
    const run = { id: 'run', start: 0, end: 0, includeHidden: false,
        sources: [{ id: 0, text: 'A fact', name: '', author: 'user', swipe: null, hidden: false }],
        suggestions: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending', conflict: true }, { id: 'c', status: 'pending', modelAuthored: true }] };
    const state = { runs: [], history: [] };
    const controller = { busy: false, state: async () => state, assertContext() {},
        analyze: async () => { state.runs.push(run); return { run }; },
        apply: async (runId, id) => { run.suggestions.find(item => item.id === id).status = 'applied'; } };
    const host = { settings: () => config, capture: () => context, isGenerating: () => false, getKey: () => '',
        countTokens: async () => 100, notify: event => notices.push(event) };
    return { config, notices, run, state, controller, host, auto: new CanonAutomation(controller, host) };
}

test('start and completion distinguish saved records from suggestions left for review', async () => {
    const f = fixture(); await f.auto.tick();
    assert.equal(f.notices[0].type, 'started');
    assert.deepEqual(f.notices[1], { type: 'completed', found: 3, saved: 1, pending: 2, uncertain: 0 });
    await f.auto.tick(); assert.equal(f.notices.length, 2, 'Already processed scenes stay quiet');
});

test('below threshold and disabled automation remain quiet', async () => {
    const f = fixture(); f.config.autoMessages = 20; await f.auto.tick();
    f.config.autoEnabled = false; await f.auto.tick(); assert.deepEqual(f.notices, []);
});

test('partial evidence results report invalid proposals and pause paid automatic retries', async () => {
    for (const allInvalid of [false, true]) {
        const f = fixture();
        f.run.validationIssues = [{ title: 'Ошибка', messageId: 0, quote: 'A [...] fact', reason: 'No exact quote' }];
        if (allInvalid) f.run.suggestions = [];
        await f.auto.tick();
        assert.equal(f.auto.blocked, true);
        assert.equal(f.notices[1].invalid, 1);
        assert.equal(f.notices[1].saved, allInvalid ? 0 : 1);
        await f.auto.tick(); assert.equal(f.notices.length, 2);
        let message;
        showAutomationNotice(f.notices[1], { info: value => { message = value; } });
        assert.match(message, /ошибками проверки: 1/);
        assert.match(message, /повторы приостановлены/);
        assert.equal(message.includes('Новых устойчивых деталей нет'), false);
        assert.equal(message.includes('A [...] fact'), false, 'Notifications must not include source quotations');
    }
});

test('bad keys pause automation without saving the blocked finding or repeating generation', async () => {
    const f = fixture(); f.run.suggestions[0].keywordIssue = 'Нужны два regex-ключа';
    await f.auto.tick();
    assert.equal(f.run.suggestions[0].status, 'pending');
    assert.equal(f.notices[1].saved, 0);
    assert.equal(f.notices[1].invalid, 1);
    assert.equal(f.auto.blocked, true);
    await f.auto.tick(); assert.equal(f.notices.length, 2);
});

test('review-only and empty-result runs emit completion without claiming saved entries', async () => {
    const f = fixture(); f.config.autoSave = false; await f.auto.tick();
    assert.equal(f.notices[1].saved, 0); assert.equal(f.notices[1].pending, 3);
    const empty = fixture(); empty.run.suggestions = []; await empty.auto.tick();
    assert.equal(empty.notices[1].found, 0); assert.equal(empty.notices[1].saved, 0);
});

test('notification failures do not prevent saving or block automation', async () => {
    const f = fixture(); f.host.notify = () => { throw new Error('UI unavailable'); };
    await f.auto.tick(); assert.equal(f.run.suggestions[0].status, 'applied'); assert.equal(f.auto.blocked, false);
});

test('unreadable journal does not fabricate pending or uncertain operation counts', async () => {
    const f = fixture(); f.controller.state = async () => { throw new Error('Storage unavailable'); };
    const result = await f.auto.summary(f.host.capture(), f.run, 1);
    assert.deepEqual(result, { found: 3, saved: 1, unverified: true });
    let message;
    showAutomationNotice({ type: 'failed', error: 'Ошибка', ...result }, { error: value => { message = value; } });
    assert.ok(message.includes('Остальные результаты не удалось проверить'));
    assert.equal(message.includes('Ожидают проверки:'), false);
});

test('toast adapter uses text escaping, redacts session key and keeps error visible', () => {
    const calls = [];
    const toast = Object.fromEntries(['info', 'success', 'error'].map(level => [level, (...args) => calls.push({ level, args })]));
    showAutomationNotice({ type: 'started', start: 0, end: 19 }, toast);
    showAutomationNotice({ type: 'completed', found: 3, saved: 2, pending: 1 }, toast);
    showAutomationNotice({ type: 'failed', error: '<img onerror=bad()> secret-value', saved: 1, found: 3, pending: 1, uncertain: 1 }, toast, 'secret-value');
    assert.deepEqual(calls.map(call => call.level), ['info', 'success', 'error']);
    assert.ok(calls[1].args[0].includes('Сохранено записей: 2'));
    assert.ok(calls[2].args[0].includes('Неподтверждённых операций: 1'));
    assert.equal(calls[2].args[0].includes('secret-value'), false);
    for (const call of calls) assert.equal(call.args[2].escapeHtml, true);
    assert.equal(calls[2].args[2].timeOut, 0); assert.equal(calls[2].args[2].closeButton, true);
    assert.doesNotThrow(() => showAutomationNotice({ type: 'started' }, undefined));
});


test('manual completion and book creation have meaningful titles and bodies, including empty results', () => {
    const calls=[];const toast={success:(...args)=>calls.push(args)};
    showAutomationNotice({type:'manual_completed',found:2},toast);
    showAutomationNotice({type:'manual_completed',found:0},toast);
    showAutomationNotice({type:'book_created',book:'Persona Weaver — Ая'},toast);
    assert.match(calls[0][0],/дополнений: 2/);assert.match(calls[0][1],/Анализ завершён/);
    assert.match(calls[1][0],/Изменений не требуется/);assert.match(calls[2][0],/Создан и привязан.*Ая/);
    assert.match(calls[2][1],/Лорбук создан/);for(const call of calls)assert.equal(call[2].escapeHtml,true);
    assert.doesNotThrow(()=>showAutomationNotice({type:'book_created',book:'x'},{success(){throw Error('toast failure')}}));
});
