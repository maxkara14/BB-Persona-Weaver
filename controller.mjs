import { canRestore, managedEntries, parseResult, rangeCoverage, selectSources, validateSuggestions } from './core.mjs';
import { analysisPrompt } from './prompt.mjs';
import { requestAnalysis, safeConnection } from './connections.mjs';
import { parseKeys, validateGeneratedKeys } from './keys.mjs';
import { assertSectionTarget, customCategory, entryOrder, sectionEntries, sectionSuggestions, sectionTitle, SECTION_NAMES } from './sections.mjs';
import { compressionPrompt, compressionResults } from './compression.mjs';

const uid = () => crypto.randomUUID();

/** All mutations are serialized. The host supplies ST/network/storage adapters. */
export class CanonController {
    constructor(host) { this.host = host; this.busy = false; this.abort = null; this.activity = null; this.listeners = new Set(); this.states = new Map(); this.loads = new Map(); }

    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    report(activity) {
        this.activity = activity;
        for (const listener of this.listeners) { try { listener(); } catch { /* UI must not interrupt analysis. */ } }
    }

    cancel() { this.abort?.abort(new Error('Анализ отменён.')); }

    assertContext(context) {
        const current = this.host.capture();
        if (current.identity !== context.identity || current.book !== context.book) throw new Error('Персона, чат или лорбук изменились. Откройте актуальный контекст.');
        return current;
    }

    async state(context) {
        if (!this.states.has(context.identity)) {
            if (!this.loads.has(context.identity)) this.loads.set(context.identity, this.host.loadState(context.identity));
            try { this.states.set(context.identity, await this.loads.get(context.identity)); }
            finally { this.loads.delete(context.identity); }
        }
        return this.states.get(context.identity);
    }

    async persist(context, next) {
        await this.host.saveState(context.identity, next);
        this.states.set(context.identity, next);
    }

    async exclusive(work) {
        if (this.busy) throw new Error('Дождитесь завершения текущей операции.');
        this.busy = true;
        try { return await work(); } finally { this.busy = false; this.abort = null; if (this.activity) this.report(null); }
    }

    async inspect(start, end, includeHidden) {
        const context = this.host.capture();
        const state = await this.state(context);
        const sources = selectSources(context.chat, start, end, { includeHidden });
        return rangeCoverage(context.chat, sources, state.runs);
    }

    async compress({ ids, config, key, retryId = null }) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const state = await this.state(context);
            const retry = retryId ? state.compressions?.find(item => item.id === retryId) : null;
            if (retryId && (!retry || retry.status !== 'pending' || retry.book !== context.book)) throw new Error('Перегенерация этой записи недоступна.');
            if (retry && state.history.some(item => item.compressionId === retry.id && item.status === 'prepared')) throw new Error('Сначала проверьте сохранение в истории.');
            const selected = retry ? [String(retry.before.uid)] : [...new Set((ids ?? []).map(String))];
            if (!context.book || !selected.length || selected.length > 20) throw new Error('Выберите от 1 до 20 записей для сжатия.');
            const abort = this.abort = new AbortController();
            this.report({ label: 'Сжатие записей', stage: 'Подготовка запроса…' });
            const book = await this.host.readBook(context.book);
            const managed = new Map(managedEntries(book, context.persona).map(entry => [String(entry.uid), entry]));
            const entries = selected.map(id => {
                const entry = managed.get(String(id));
                if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) throw new Error('Выбранная запись не найдена или не управляется этой персоной.');
                return structuredClone(entry);
            });
            if (retry && !canRestore(retry.before, entries[0])) throw new Error('Запись изменилась после сжатия. Выберите её заново.');
            this.assertContext(context); abort.signal.throwIfAborted();
            const prompt = compressionPrompt(entries, config.compressionPrompt);
            const inputTokens = await this.host.countTokens(JSON.stringify(prompt));
            if (inputTokens > this.host.contextLimit() - config.maxTokens) throw new Error('Выбранные записи и ответ не помещаются в бюджет. Выберите меньше записей или увеличьте бюджет.');
            this.report({ label: 'Сжатие записей', stage: 'Ожидание ответа модели…' });
            const answer = await requestAnalysis(this.host, config, key, prompt, abort);
            abort.signal.throwIfAborted(); this.assertContext(context);
            const results = compressionResults(parseResult(answer), entries);
            const latest = await this.host.readBook(context.book);
            for (const entry of entries) if (!canRestore(latest.entries[entry.uid], entry)) throw new Error('Запись изменилась во время сжатия. Результат не применён.');
            const proposals = [];
            for (const before of entries) proposals.push({ id: retry?.id ?? uid(), book: context.book, before, content: results.get(String(before.uid)),
                date: new Date().toISOString(), status: 'pending', beforeTokens: await this.host.countTokens(before.content), afterTokens: await this.host.countTokens(results.get(String(before.uid))), connection: safeConnection(config, this.host) });
            this.assertContext(context); abort.signal.throwIfAborted();
            const next = structuredClone(await this.state(context)); next.compressions ??= [];
            if (retry) next.compressions[next.compressions.findIndex(item => item.id === retry.id)] = proposals[0];
            else next.compressions.push(...proposals);
            await this.persist(context, next);
            return proposals;
        });
    }

    async editCompression(id, patch, draftContext = null) {
        return this.exclusive(async () => {
            const context = draftContext ?? this.host.capture();
            const next = structuredClone(await this.state(context));
            const item = next.compressions?.find(item => item.id === id);
            if (!item || item.status !== 'pending' || next.history.some(operation => operation.compressionId === id && operation.status === 'prepared')) throw new Error('Предложение сжатия больше недоступно для редактирования.');
            if (Object.hasOwn(patch, 'content')) {
                if (typeof patch.content !== 'string' || patch.content.length > 500000) throw new Error('Некорректный текст сжатой записи.');
                item.content = patch.content; item.afterTokens = await this.host.countTokens(patch.content);
            }
            if (patch.status === 'rejected') item.status = 'rejected';
            await this.persist(context, next);
        });
    }

    async applyCompression(id) {
        return this.exclusive(async () => {
            const context = this.host.capture(); const state = await this.state(context);
            const pending = state.history.find(item => item.compressionId === id && item.status === 'prepared');
            if (pending) return this.finish(context, pending);
            const item = state.compressions?.find(item => item.id === id);
            if (!item || item.status !== 'pending' || item.book !== context.book || !item.content.trim()) throw new Error('Сжатие не готово к сохранению.');
            const book = await this.host.readBook(context.book); this.assertContext(context);
            if (item.before.personaCanon?.persona !== context.persona || !canRestore(book.entries[item.before.uid], item.before)) throw new Error('Запись изменилась после сжатия. Сохранение заблокировано.');
            const after = structuredClone(item.before); after.content = item.content.trim();
            return this.prepare(context, { id: uid(), kind: 'compress', uid: item.before.uid, before: item.before, after, compressionId: id });
        });
    }

    async analyze({ start, end, includeHidden, force, config, key }) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const abort = this.abort = new AbortController();
            this.report({ start, end, stage: 'Подготовка запроса…' });
            const state = await this.state(context);
            const sources = selectSources(context.chat, start, end, { includeHidden });
            const coverage = rangeCoverage(context.chat, sources, state.runs);
            if (coverage.covered && !force) return { repeated: true, coverage };
            const book = context.book ? await this.host.readBook(context.book) : { entries: {} };
            this.assertContext(context); abort.signal.throwIfAborted();
            const entries = managedEntries(book, context.persona);
            sectionEntries(entries);
            const prompt = analysisPrompt(context, sources, entries, config.prompt, { saveEvents: config.saveEvents === true });
            const inputTokens = await this.host.countTokens(JSON.stringify(prompt));
            this.host.onEstimate?.(inputTokens);
            if (inputTokens > this.host.contextLimit() - config.maxTokens) throw new Error('Запрос и ответ не помещаются в выбранный бюджет контекста. Уменьшите диапазон или измените бюджет.');
            const connection = safeConnection(config, this.host);
            abort.signal.throwIfAborted();
            this.report({ start, end, stage: 'Ожидание ответа модели…' });
            const text = await requestAnalysis(this.host, config, key, prompt, abort);
            abort.signal.throwIfAborted();
            this.report({ start, end, stage: 'Проверка ответа…' });
            const current = this.assertContext(context);
            if (current.description !== context.description || !canRestore(selectSources(current.chat, start, end, { includeHidden }), sources)) {
                throw new Error('Исходные сообщения или описание персоны изменились во время анализа. Результат не применён.');
            }
            const result = parseResult(text);
            if (Array.isArray(result?.suggestions)) for (const suggestion of result.suggestions) validateGeneratedKeys(suggestion?.keywords);
            const validationIssues = [];
            const validated = validateSuggestions(result, { sources,
                allowCustom: true, customCategories: entries.map(entry => entry.personaCanon.category),
                onEvidenceIssue: issue => validationIssues.push(issue),
                entries: entries.map(entry => ({ id: String(entry.uid), content: entry.content })) });
            const suggestions = sectionSuggestions(validated, entries, context.personaName);
            const run = { id: uid(), book: context.book, context: context.identity, persona: context.persona,
                chatName: context.chatName, description: context.description, start, end, includeHidden, sources,
                date: new Date().toISOString(), rules: 1, sectionVersion: 1, connection, inputTokens, validationIssues,
                baselines: Object.fromEntries(entries.map(entry => [String(entry.uid), entry])),
                suggestions: suggestions.map(suggestion => {
                    const previous = suggestion.target === null ? null : entries.find(entry => String(entry.uid) === suggestion.target);
                    return { ...suggestion, id: uid(), label: 'chat',
                        entryOrder: { mode: config.entryOrderMode ?? 'manual', value: config.entryOrderValue ?? 100, reverseStart: config.entryReverseStart ?? 9999 },
                        keywords: previous ? [...new Set([...(previous.key ?? []), ...parseKeys(suggestion.keywords)])].join('\n') : suggestion.keywords,
                        constant: previous?.constant ?? config.entryConstant ?? false,
                        vectorized: previous?.vectorized ?? config.entryVectorized ?? false,
                        excludeRecursion: previous?.excludeRecursion ?? config.entryExcludeRecursion ?? false,
                        preventRecursion: previous?.preventRecursion ?? config.entryPreventRecursion ?? false };
                }),
            };
            const next = structuredClone(state); next.runs.push(run);
            await this.persist(context, next);
            return { run };
        });
    }

    async edit(runId, suggestionId, patch, draftContext = null) {
        return this.exclusive(async () => {
            // Local drafts may finish saving to their original chat after navigation.
            const context = draftContext ?? this.host.capture();
            const next = structuredClone(await this.state(context));
            const suggestion = next.runs.find(run => run.id === runId)?.suggestions.find(item => item.id === suggestionId);
            if (!suggestion || suggestion.status !== 'pending') throw new Error('Предложение больше не ожидает решения.');
            for (const field of ['content', 'label', 'keywords', 'constant', 'vectorized', 'excludeRecursion', 'preventRecursion', 'status']) {
                if (Object.hasOwn(patch, field)) suggestion[field] = patch[field];
            }
            await this.persist(context, next);
        });
    }

    async configureCategory(runId, suggestionId, { name, destination = 'new' }) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const next = structuredClone(await this.state(context));
            const run = next.runs.find(item => item.id === runId);
            const suggestion = run?.suggestions.find(item => item.id === suggestionId);
            if (!suggestion?.categoryProposal || suggestion.status !== 'pending') throw new Error('Предложение новой категории недоступно.');
            if (next.history.some(item => item.status === 'prepared' && item.suggestionId === suggestionId)) throw new Error('Сначала проверьте незавершённую запись в истории.');
            const entries = Object.values(run.baselines);
            const sections = sectionEntries(entries);
            if (suggestion.categoryName && suggestion.target === null) {
                suggestion.categoryProposal.content = suggestion.content;
                suggestion.categoryProposal.keywords = suggestion.keywords;
            }
            let chosen;
            if (destination === 'new') chosen = customCategory(name);
            else {
                const entry = sections.get(destination);
                if (!Object.hasOwn(SECTION_NAMES, destination) && !entry) throw new Error('Выберите существующий раздел.');
                chosen = { category: destination, categoryName: entry?.personaCanon.categoryName };
            }
            if (destination === 'new' && sections.has(chosen.category)) throw new Error('Категория уже существует. Выберите её в списке разделов.');
            const entry = sections.get(chosen.category);
            Object.assign(suggestion, chosen, { title: sectionTitle(chosen.category, context.personaName, chosen.categoryName), target: entry ? String(entry.uid) : null,
                before: entry?.content ?? null, content: entry ? `${entry.content}\n\n${suggestion.categoryProposal.content}` : suggestion.categoryProposal.content,
                keywords: [...new Set([...(entry?.key ?? []), ...parseKeys(suggestion.categoryProposal.keywords)])].join('\n'),
                constant: entry?.constant ?? suggestion.constant, vectorized: entry?.vectorized ?? suggestion.vectorized,
                excludeRecursion: entry?.excludeRecursion ?? suggestion.excludeRecursion, preventRecursion: entry?.preventRecursion ?? suggestion.preventRecursion });
            await this.persist(context, next);
        });
    }

    async apply(runId, suggestionId, { automatic = false } = {}) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const state = await this.state(context);
            const pending = state.history.find(item => item.status === 'prepared' && item.runId === runId && item.suggestionId === suggestionId);
            if (automatic && state.runs.find(item => item.id === runId)?.suggestions.find(item => item.id === suggestionId)?.requiresCategoryApproval) throw new Error('Новая категория требует ручного подтверждения.');
            if (pending) return this.finish(context, pending);
            const run = state.runs.find(item => item.id === runId);
            const suggestion = run?.suggestions.find(item => item.id === suggestionId);
            if (!suggestion || suggestion.status !== 'pending') throw new Error('Предложение уже обработано.');
            if (automatic && suggestion.requiresCategoryApproval) throw new Error('Новая категория требует ручного подтверждения.');
            if (run.sectionVersion !== 1) throw new Error('Эта находка создана до перехода на записи по разделам. Повторите анализ.');
            if (!suggestion.content.trim()) throw new Error('Текст записи не может быть пустым.');
            if (run.book !== context.book || run.description !== context.description
                || !canRestore(selectSources(context.chat, run.start, run.end, { includeHidden: run.includeHidden }), run.sources)) {
                throw new Error('Источники, персона или книга изменились после анализа. Нужен повторный анализ.');
            }
            if (!context.book) {
                context.book = await this.host.ensureBook(context);
                const next = structuredClone(await this.state(context));
                for (const item of next.runs) if (!item.book) item.book = context.book;
                await this.persist(context, next);
            }
            const book = await this.host.readBook(context.book);
            this.assertContext(context);
            assertSectionTarget(managedEntries(book, context.persona), suggestion);
            let before = null, entry;
            if (suggestion.target !== null) {
                before = book.entries[suggestion.target];
                if (!before || !canRestore(before, run.baselines[suggestion.target])) throw new Error('Запись изменена после анализа. Правка не сохранена; повторите анализ.');
                entry = structuredClone(before);
            } else {
                if (managedEntries(book, context.persona).some(item => item.comment?.trim().toLowerCase() === suggestion.title.toLowerCase())) {
                    throw new Error('Такая запись уже создана. Повторите анализ, чтобы предложить обновление.');
                }
                entry = this.host.makeEntry(book);
                if (!entry) throw new Error('Не удалось выделить ID новой записи.');
                delete book.entries[entry.uid];
            }
            const operationId = uid();
            if (!before) entry.order = entryOrder(suggestion.entryOrder, managedEntries(book, context.persona).length + 1);
            Object.assign(entry, { comment: suggestion.title, content: suggestion.content.trim(),
                key: parseKeys(suggestion.keywords), constant: Boolean(suggestion.constant),
                vectorized: Boolean(suggestion.vectorized ?? entry.vectorized), excludeRecursion: Boolean(suggestion.excludeRecursion ?? entry.excludeRecursion), preventRecursion: Boolean(suggestion.preventRecursion ?? entry.preventRecursion) });
            if (!entry.constant && !entry.vectorized && !entry.key.length) throw new Error('Введите ключи активации либо включите постоянную активацию или векторизацию.');
            entry.personaCanon = { version: 1, section: true, persona: context.persona, category: suggestion.category, ...(suggestion.categoryName ? { categoryName: suggestion.categoryName } : {}),
                origins: [...(entry.personaCanon?.origins ?? []), { id: operationId, kind: suggestion.label === 'general' ? 'general' : 'chat',
                    context: context.identity, chatName: context.chatName, evidence: suggestion.evidence, date: new Date().toISOString() }] };
            return this.prepare(context, { id: operationId, kind: 'apply', uid: entry.uid, before, after: entry, runId, suggestionId });
        });
    }

    async prepare(context, operation) {
        const next = structuredClone(await this.state(context));
        Object.assign(operation, { book: context.book, date: new Date().toISOString(), status: 'prepared' });
        next.history.push(operation);
        this.assertContext(context);
        await this.persist(context, next); // Durable intent precedes the external write.
        return this.finish(context, operation);
    }

    async finish(context, operation) {
        if (operation.book !== context.book) throw new Error('Для этой операции нужна исходная книга.');
        const book = await this.host.readBook(operation.book);
        this.assertContext(context);
        const current = book.entries[operation.uid] ?? null;
        // A previous request may have reached the server even if the reply was lost.
        if (!canRestore(current, operation.after)) {
            if (!canRestore(current, operation.before)) throw new Error('Запись изменена вручную. Операция остановлена; версии доступны в истории.');
            if (operation.kind === 'apply') {
                const run = (await this.state(context)).runs.find(item => item.id === operation.runId);
                const latest = this.assertContext(context);
                if (!run || latest.description !== run.description || !canRestore(selectSources(latest.chat, run.start, run.end, { includeHidden: run.includeHidden }), run.sources)) {
                    throw new Error('Источники изменились. Незавершённая правка не будет применена; выполните новый анализ.');
                }
                if (operation.after?.personaCanon?.section) {
                    const others = managedEntries(book, context.persona).filter(entry => String(entry.uid) !== String(operation.uid));
                    if (others.some(entry => entry.personaCanon.category === operation.after.personaCanon.category)) {
                        throw new Error('Другой экземпляр раздела появился перед сохранением. Запись остановлена; проверьте историю и повторите анализ.');
                    }
                }
            }
            if (operation.after === null) delete book.entries[operation.uid];
            else book.entries[operation.uid] = structuredClone(operation.after);
            this.assertContext(context);
            await this.host.writeBook(operation.book, book);
        }
        // Finalize the ORIGINAL context even if the user switched chats during HTTP.
        const next = structuredClone(await this.state(context));
        next.history.find(item => item.id === operation.id).status = 'applied';
        if (operation.kind === 'apply') {
            const suggestion = next.runs.find(run => run.id === operation.runId)?.suggestions.find(item => item.id === operation.suggestionId);
            if (suggestion) suggestion.status = 'applied';
        }
        if (operation.compressionId) {
            const compression = next.compressions?.find(item => item.id === operation.compressionId);
            if (compression) compression.status = 'applied';
        }
        if (operation.undoOf) {
            const original = next.history.find(item => item.id === operation.undoOf);
            original.status = 'undone';
            const suggestion = next.runs.find(run => run.id === original.runId)?.suggestions.find(item => item.id === original.suggestionId);
            if (suggestion) suggestion.status = 'reverted';
            if (original.compressionId) {
                const compression = next.compressions?.find(item => item.id === original.compressionId);
                if (compression) compression.status = 'reverted';
            }
        }
        await this.persist(context, next);
    }

    async recover(operationId) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const operation = (await this.state(context)).history.find(item => item.id === operationId && item.status === 'prepared');
            if (!operation) throw new Error('Незавершённая операция не найдена.');
            return this.finish(context, operation);
        });
    }

    async undo(operationId) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const state = await this.state(context);
            const prepared = state.history.find(item => item.status === 'prepared' && item.undoOf === operationId);
            if (prepared) return this.finish(context, prepared);
            const operation = state.history.find(item => item.id === operationId);
            if (!operation || operation.status !== 'applied' || operation.undoOf || operation.book !== context.book) throw new Error('Откат этой операции недоступен.');
            const book = await this.host.readBook(context.book);
            if (!canRestore(book.entries[operation.uid] ?? null, operation.after)) throw new Error('После этой операции запись изменилась. Автоматический откат заблокирован. Старая версия доступна в истории.');
            return this.prepare(context, { id: uid(), kind: 'undo', uid: operation.uid,
                before: operation.after, after: operation.before, undoOf: operation.id });
        });
    }

    async relabel(entryId, originId, kind) {
        return this.exclusive(async () => {
            const context = this.host.capture();
            const book = await this.host.readBook(context.book);
            const before = book.entries[entryId];
            if (before?.personaCanon?.persona !== context.persona) throw new Error('Запись не управляется этой персоной.');
            const after = structuredClone(before);
            const origin = after.personaCanon.origins.find(item => item.id === originId);
            if (!origin) throw new Error('Источник не найден.');
            origin.kind = kind === 'general' ? 'general' : 'chat';
            return this.prepare(context, { id: uid(), kind: 'label', uid: before.uid, before, after });
        });
    }
}
