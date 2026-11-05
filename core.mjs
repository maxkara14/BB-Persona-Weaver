/**
 * Approved direction: manual scene analysis, evidence-backed suggestions,
 * explicit review before writes, one persona book and informational labels.
 * Pure policy module; no network, storage, or SillyTavern side effects.
 */
import { evidenceSources } from './evidence.mjs';

export const CATEGORIES = Object.freeze({
    appearance: 'Внешность',
    habits: 'Привычки и предпочтения',
    skills: 'Навыки и ограничения',
    history: 'Прошлое и семья',
    values: 'Ценности и границы',
    relationships: 'Отношения',
});

export function contextIdentity({ persona, character, group, integrity }) {
    if (typeof persona !== 'string' || !persona || typeof integrity !== 'string' || !integrity) {
        throw new Error('Не выбрана персона или не загружен сохранённый чат.');
    }
    const owner = group != null ? ['group', String(group)] : ['character', character];
    if (typeof owner[1] !== 'string' || !owner[1]) throw new Error('Не определён владелец чата.');
    // integrity survives renaming; a branch receives a new integrity in this ST.
    return JSON.stringify([persona, ...owner, integrity]);
}

export function selectSources(chat, start, end, { includeHidden = false } = {}) {
    if (!Array.isArray(chat) || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end < start || end >= chat.length) {
        throw new Error('Некорректный диапазон сообщений.');
    }
    const sources = [];
    for (let id = start; id <= end; id++) {
        const message = chat[id];
        // ST uses is_system for hidden messages. Inclusion is an explicit choice.
        if (!message || (!includeHidden && message.is_system) || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        sources.push({
            id, text: message.mes, name: String(message.name ?? ''),
            author: message.is_user ? 'user' : 'model',
            swipe: message.swipe_id ?? null, hidden: Boolean(message.is_system),
        });
    }
    if (!sources.length) throw new Error('В диапазоне нет доступных текстовых сообщений.');
    return sources;
}

export function sourcesAreCurrent(chat, sources) {
    return sources.every(source => {
        const message = chat[source.id];
        return message && message.mes === source.text && String(message.name ?? '') === source.name
            && (message.is_user ? 'user' : 'model') === source.author
            && (message.swipe_id ?? null) === source.swipe && Boolean(message.is_system) === source.hidden;
    });
}

function requiredText(value, label, maxLength) {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
        throw new Error(`Некорректное поле: ${label}.`);
    }
    return value.trim();
}

/** Model output contract: { suggestions: [{ target, category, title, content,
 * reason, conflict, evidence: [{ messageId, quote }] }] }.
 * target is null for creation, otherwise a permitted existing entry ID.
 * Labels, ownership, authorship and lifecycle status are assigned by the app.
 * With onEvidenceIssue, reject only the proposal with invalid evidence;
 * malformed top-level/schema data still fails the complete response.
 */
export function validateSuggestions(result, { sources, entries = [], onEvidenceIssue, allowCustom = false, customCategories = [] }) {
    if (!result || !Array.isArray(result.suggestions) || result.suggestions.length > 20) {
        throw new Error('Ожидается объект suggestions с максимум 20 предложениями.');
    }
    const byId = new Map(sources.map(source => [source.id, source]));
    const paragraphs = evidenceSources(sources);
    const targets = new Map(entries.map(entry => [String(entry.id), entry]));
    const used = new Set();
    return result.suggestions.map(raw => {
        if (!raw || typeof raw.category !== 'string' || !(Object.hasOwn(CATEGORIES, raw.category) || customCategories.includes(raw.category) || (allowCustom && raw.category === 'custom')) || typeof raw.conflict !== 'boolean') {
            throw new Error('Некорректная категория или отметка конфликта.');
        }
        const title = requiredText(raw.title, 'название', 160);
        const content = requiredText(raw.content, 'содержание', 16000);
        const reason = requiredText(raw.reason, 'обоснование', 2000);
        if (raw.target !== null && typeof raw.target !== 'string') throw new Error('Некорректная целевая запись.');
        const existing = raw.target === null ? null : targets.get(raw.target);
        if (raw.target !== null && !existing) throw new Error('Запись не разрешена для обновления.');
        const key = existing ? `entry:${raw.target}` : `new:${raw.category}:${title.toLocaleLowerCase()}`;
        if (used.has(key)) throw new Error('Несколько предложений для одной записи: нужен согласованный вариант.');
        let failedEvidence;
        let evidence;
        try {
            if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 12) {
                throw new Error('У предложения должны быть подтверждающие источники (от 1 до 12 цитат).');
            }
            evidence = raw.evidence.map(item => {
                failedEvidence = item;
                if (item && Object.hasOwn(item, 'sourceId')) {
                    const original = paragraphs.get(item.sourceId);
                    if (!original) throw new Error('Указанный ID абзаца отсутствует в отправленной сцене.');
                    return { ...original };
                }
                const source = byId.get(item?.messageId);
                const quote = requiredText(item?.quote, 'цитата', 4000);
                if (!source) throw new Error('Указанное сообщение отсутствует в выбранной сцене.');
                if (!source.text.includes(quote)) throw new Error('Цитата отсутствует в выбранном сообщении. Нужен непрерывный дословный фрагмент без сокращений и склейки.');
                return { messageId: source.id, quote, author: source.author };
            });
        } catch (error) {
            if (!onEvidenceIssue) throw error;
            onEvidenceIssue({ title, reason: error.message,
                sourceId: typeof failedEvidence?.sourceId === 'string' ? failedEvidence.sourceId.slice(0, 80) : null,
                messageId: Number.isInteger(failedEvidence?.messageId) ? failedEvidence.messageId : /^\d+:/.test(failedEvidence?.sourceId ?? '') ? Number(failedEvidence.sourceId.split(':')[0]) : null,
                quote: typeof failedEvidence?.quote === 'string' ? failedEvidence.quote.slice(0, 4000) : '' });
            return null;
        }
        used.add(key);
        return {
            target: raw.target, category: raw.category, title, content, reason,
            ...(raw.category === 'custom' ? { categoryName: raw.categoryName, categoryReason: raw.categoryReason } : {}),
            before: existing?.content ?? null, conflict: raw.conflict, evidence,
            keywords: Array.isArray(raw.keywords) && raw.keywords.every(key => typeof key === 'string' && key.length <= 3000) ? raw.keywords.slice(0, 30).join('\n') : '',
            modelAuthored: evidence.some(item => item.author === 'model'), status: 'pending',
        };
    }).filter(Boolean);
}

export function managedEntries(book, persona) {
    return Object.values(book.entries ?? {}).filter(entry => entry.personaCanon?.version === 1 && entry.personaCanon.persona === persona);
}

export function entryLabels(entry) {
    const labels = new Map();
    for (const origin of entry.personaCanon?.origins ?? []) {
        const key = origin.kind === 'general' ? 'general' : origin.context;
        labels.set(key, origin.kind === 'general' ? 'Общее' : `Из чата: ${origin.chatName}`);
    }
    return [...labels.values()];
}

export function rangeCoverage(chat, sources, runs) {
    const covered = new Set();
    let changed = false;
    for (const run of runs) {
        if (run.validationIssues?.length) continue;
        if (!run.sources.some(old => sources.some(source => source.id === old.id))) continue;
        let current;
        try { current = selectSources(chat, run.start, run.end, { includeHidden: run.includeHidden }); }
        catch { changed = true; continue; }
        if (!canRestore(current, run.sources)) { changed = true; continue; }
        for (const source of sources) {
            if (run.sources.some(old => old.id === source.id && canRestore(old, source))) covered.add(source.id);
        }
    }
    return { covered: covered.size, ids: [...covered], total: sources.length,
        status: covered.size === sources.length ? 'done' : covered.size ? 'partial' : changed ? 'changed' : 'new' };
}

export function parseResult(text) {
    if (typeof text !== 'string' || text.length > 500000) throw new Error('Ответ пуст или слишком велик.');
    const clean = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
    try { return JSON.parse(clean); } catch { throw new Error('Модель вернула невалидный JSON. Попробуйте повторить анализ.'); }
}

export function canRestore(current, applied) {
    // Compare the full record: manual keyword/activation edits matter too.
    return canonical(current) === canonical(applied);
}

function canonical(value) {
    if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
    if (value && typeof value === 'object') {
        return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
    }
    return JSON.stringify(value ?? null);
}
