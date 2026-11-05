import { getContext } from '../../../extensions.js';
import { eventSource, event_types, isGenerating, saveSettingsDebounced } from '../../../../script.js';
import { user_avatar, getOrCreatePersonaDescriptor, setPersonaDescription } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { getCurrentUserHandle } from '../../../user.js';
import { getChatCompletionModel } from '../../../openai.js';
import { getTextGenModel } from '../../../textgen-settings.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { createWorldInfoEntry, reloadEditor, updateWorldInfoList, world_names, worldInfoCache } from '../../../world-info.js';
import { contextIdentity } from './core.mjs';
import { CanonController } from './controller.mjs';
import { loadState, saveState } from './storage.mjs';
import { createInterface } from './ui.mjs';
import { CanonAutomation } from './automation.mjs';
import { createAndBindBook } from './create-book.mjs';
import { showAutomationNotice } from './notifications.mjs';

const NAME = 'Persona-Canon';
const defaults = { mode: 'current', profileId: '', url: '', customApiKey: '', model: '', timeout: 120, maxTokens: 4096, budget: 32000,
    prompt: '', compressionPrompt: '', saveEvents: false, entryOrderMode: 'manual', entryOrderValue: 100, entryReverseStart: 9999, entryConstant: false, entryVectorized: false, entryExcludeRecursion: false, entryPreventRecursion: false,
    autoEnabled: false, autoContext: '', autoTrigger: 'messages', autoMessages: 20, autoTokens: 4000, autoSave: false };
// Match Enhance: persist the custom API key with the user's extension settings.
const getKey = () => settings().customApiKey;
let refreshView = () => {};

function settings() {
    const ctx = getContext();
    const stored = ctx.extensionSettings[NAME] ?? {};
    const result = { ...defaults, ...stored };
    result.mode = ['current', 'profile', 'custom'].includes(result.mode) ? result.mode : 'current';
    result.entryOrderMode = ['auto', 'reverse', 'manual'].includes(result.entryOrderMode) ? result.entryOrderMode : 'manual';
    for (const key of ['entryOrderValue', 'entryReverseStart']) result[key] = Number.isFinite(Number(result[key])) ? Math.min(9999, Math.max(0, Math.trunc(Number(result[key])))) : defaults[key];
    for (const [key, min, max] of [['timeout', 15, 600], ['maxTokens', 256, 32000], ['budget', 1024, 2000000], ['autoMessages', 1, 1000], ['autoTokens', 100, 200000]]) {
        result[key] = Math.min(max, Math.max(min, Math.floor(Number(result[key]) || defaults[key])));
    }
    result.customApiKey = typeof result.customApiKey === 'string' ? result.customApiKey : '';
    return result;
}

function capture() {
    const ctx = getContext();
    const persona = user_avatar;
    return {
        identity: contextIdentity({ persona, character: ctx.characters[ctx.characterId]?.avatar,
            group: ctx.groupId || null, integrity: ctx.chatMetadata.integrity }),
        persona, personaName: ctx.name1, chatName: String(ctx.getCurrentChatId() ?? ''),
        book: power_user.persona_description_lorebook || '', description: power_user.persona_description || '', chat: ctx.chat,
    };
}

async function readBook(name) {
    // /get returns {entries:{}} even for a missing file. Check existence first
    // so a deleted/renamed book cannot be silently recreated by an edit.
    const listing = await fetch('/api/worldinfo/list', { method: 'POST', cache: 'no-store', headers: getContext().getRequestHeaders() });
    if (!listing.ok) throw new Error('Не удалось проверить наличие лорбука.');
    const books = await listing.json();
    if (!Array.isArray(books) || !books.some(book => book.file_id === name)) throw new Error('Лорбук не найден. Возможно, он удалён или переименован. Обновите привязку.');
    const response = await fetch('/api/worldinfo/get', { method: 'POST', cache: 'no-store',
        headers: getContext().getRequestHeaders(), body: JSON.stringify({ name }) });
    if (!response.ok) throw new Error(`Не удалось прочитать лорбук: HTTP ${response.status}.`);
    const data = await response.json();
    if (!data || typeof data.entries !== 'object' || Array.isArray(data.entries) || data.entries === null) throw new Error('Некорректный формат лорбука.');
    return data;
}

async function writeBook(name, book) {
    let response;
    try {
        response = await fetch('/api/worldinfo/edit', { method: 'POST', headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ name, data: book }) });
    } catch { throw new Error('Ответ сохранения не получен. Проверьте операцию в истории перед повтором.'); }
    if (!response.ok) throw new Error(`Лорбук не сохранён: HTTP ${response.status}. Операция осталась в истории.`);
    if ((await response.json()).ok !== true) throw new Error('Сервер не подтвердил запись. Проверьте операцию в истории.');
    worldInfoCache.set(name, book);
    // An unrelated UI listener failure must not turn a confirmed write into failure.
    try { await eventSource.emit(event_types.WORLDINFO_UPDATED, name, structuredClone(book)); reloadEditor(name); }
    catch { /* The persisted book and journal remain authoritative. */ }
}

async function createBookFor(context, name) {
    return createAndBindBook(name, {
        async list() {
            const response = await fetch('/api/worldinfo/list', { method: 'POST', cache: 'no-store', headers: getContext().getRequestHeaders() });
            if (!response.ok) throw new Error('Не удалось проверить список лорбуков.');
            const books = await response.json();
            if (!Array.isArray(books) || !books.every(book => typeof book.file_id === 'string')) throw new Error('Некорректный список лорбуков.');
            return books.map(book => book.file_id);
        },
        assertCurrent: () => controller.assertContext(context),
        write: writeBook,
        async bind(name) {
            getOrCreatePersonaDescriptor().lorebook = name;
            power_user.persona_description_lorebook = name;
            setPersonaDescription(); saveSettingsDebounced();
            await updateWorldInfoList();
        },
    });
}

const host = {
    capture, readBook, writeBook,
    async ensureBook(context) {
        return createBookFor(context, `Persona Weaver ${crypto.randomUUID()}`);
    },
    loadState: identity => loadState(JSON.stringify([getCurrentUserHandle(), identity])),
    saveState: (identity, state) => saveState(JSON.stringify([getCurrentUserHandle(), identity]), state),
    fetch: (...args) => fetch(...args),
    profiles() { try { return ConnectionManagerRequestService.getSupportedProfiles(); } catch { return []; } },
    currentModel() {
        const ctx = getContext();
        return ctx.mainApi === 'openai' ? getChatCompletionModel() : ctx.mainApi === 'textgenerationwebui' ? getTextGenModel() : ctx.mainApi;
    },
    countTokens: text => getContext().getTokenCountAsync(text),
    contextLimit() { const config = settings(); return config.mode === 'current' ? Math.min(config.budget, getContext().maxContext || config.budget) : config.budget; },
    makeEntry: book => createWorldInfoEntry('', book),
    profileRequest(id, messages, maxTokens, signal) {
        const literal = messages.map(message => ({ ...message, content: message.content.replace(/\{\{/g, '{\u200b{') }));
        const prompt = ConnectionManagerRequestService.constructPrompt(literal, id);
        return ConnectionManagerRequestService.sendRequest(id, prompt, maxTokens, { stream: false, signal, extractData: true });
    },
    async currentRequest(messages, maxTokens, signal) {
        const ctx = getContext();
        if (isGenerating()) throw new Error('Дождитесь ответа основного чата.');
        if (ctx.onlineStatus === 'no_connection') throw new Error('Нет подключения.');
        const api = ctx.mainApi;
        const cancel = () => { if (!isGenerating()) void eventSource.emit(event_types.GENERATION_STOPPED); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            signal.throwIfAborted();
            // Raw generation expands ST macros. Literal story macros must stay data.
            const prompt = messages.map(message => ({ ...message, content: message.content.replace(/\{\{/g, '{\u200b{') }));
            const data = await ctx.generateRawData({ prompt, api, responseLength: maxTokens });
            signal.throwIfAborted();
            if (data?.choices?.[0]?.finish_reason === 'length') throw new Error('Ответ обрезан.');
            let content = ctx.extractMessageFromData(data, api);
            if (ctx.powerUserSettings.reasoning?.auto_parse) content = ctx.parseReasoningFromString(content)?.content ?? content;
            return content;
        } finally { signal.removeEventListener('abort', cancel); }
    },
};

const controller = new CanonController(host);
const uiHost = {
    ...host, settings, getKey, setKey: key => uiHost.saveSettings({ customApiKey: key.trim() }),
    saveSettings(patch) {
        const next = { ...settings(), ...patch };
        getContext().extensionSettings[NAME] = Object.fromEntries(Object.keys(defaults).map(key => [key, next[key]]));
        saveSettingsDebounced();
        automation.resume();
    },
    automationStatus: () => automation.status,
    automationActivity: () => automation.activity,
    books: () => [...(world_names ?? [])],
    refreshBooks: () => updateWorldInfoList(),
    createBook(name) { return controller.exclusive(() => createBookFor(capture(), name)); },
    async bindBook(name) {
        if (!(world_names ?? []).includes(name)) throw new Error('Выберите существующую книгу. Создать книгу можно в разделе World Info.');
        const context = capture();
        await readBook(name); controller.assertContext(context);
        getOrCreatePersonaDescriptor().lorebook = name;
        power_user.persona_description_lorebook = name;
        setPersonaDescription(); saveSettingsDebounced();
    },
    revealMessage(id) {
        const message = document.querySelector(`#chat .mes[mesid="${Number(id)}"]`);
        if (message) message.scrollIntoView({ block: 'center', behavior: 'smooth' });
        else throw new Error('Сообщение не загружено на экран. Найдите его по указанному номеру.');
    },
};

const open = createInterface(controller, uiHost, callback => { refreshView = callback; });
const automation = new CanonAutomation(controller, { ...host, settings, getKey,
    notify: event => showAutomationNotice(event, globalThis.toastr, getKey()),
    isGenerating: () => isGenerating() || Boolean(document.querySelector('#persona-canon-dialog[open]')),
    onUpdate: () => { refreshView(); } });
let autoTimer;
for (const type of [event_types.MESSAGE_RECEIVED, event_types.GENERATION_ENDED]) if (type) eventSource.on(type, () => {
    clearTimeout(autoTimer); autoTimer = setTimeout(() => { void automation.tick(); }, 1000);
});

function register() {
    document.getElementById('persona-canon-settings')?.remove();
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('persona-canon-menu')) {
        const container = document.createElement('div'); container.className = 'extension_container';
        const item = document.createElement('div'); item.id = 'persona-canon-menu';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.setAttribute('role', 'button'); item.tabIndex = 0;
        const icon = document.createElement('i'); icon.className = 'fa-fw fa-solid fa-feather-pointed extensionsMenuExtensionButton'; icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = 'Persona Weaver';
        item.append(icon, label); item.onclick = open;
        item.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); item.click(); }
        };
        container.append(item); menu.append(container);
        const trigger = document.getElementById('extensionsMenuButton'); if (trigger) trigger.style.display = 'flex';
    }
}

for (const type of [event_types.CHAT_CHANGED, event_types.PERSONA_CHANGED]) eventSource.on(type, () => {
    controller.cancel(); refreshView();
});
eventSource.on(event_types.APP_READY, register);
jQuery(register);
