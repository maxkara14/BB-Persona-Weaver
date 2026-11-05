import { CATEGORIES, entryLabels, managedEntries, rangeCoverage, selectSources } from './core.mjs';
import { listModels, safeConnection } from './connections.mjs';
import { defaultPrompt } from './prompt.mjs';
import { SECTION_NAMES } from './sections.mjs';
import { historyStatus, resultPage } from './view-state.mjs';

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(text, action, primary = false) {
    const node = el('button', text, `pc-button${primary ? ' pc-primary' : ''}`);
    node.type = 'button'; node.onclick = action; return node;
}
let fieldId = 0;
function field(label, node) {
    const wrapper = el('label', undefined, 'pc-field');
    const caption = el('span', label); caption.id = `pc-label-${++fieldId}`;
    node.setAttribute('aria-labelledby', caption.id);
    wrapper.append(caption, node); return wrapper;
}
function select(options, value) {
    const node = el('select');
    for (const [id, name] of options) { const option = el('option', name); option.value = id; node.append(option); }
    node.value = value; return node;
}
function input(value, type = 'text') { const node = el('input'); node.type = type; node.value = value; return node; }
const statusNames = { pending: 'Ожидает решения', rejected: 'Отклонено', applied: 'Сохранено', reverted: 'Отменено' };
const coverageNames = { new: 'Не анализировался', done: 'Проанализирован', partial: 'Частично проанализирован', changed: 'Изменён после анализа' };

export function createInterface(controller, host, subscribe) {
    let dialog, body, status, cancelControl, settingsControl, activityRow, activityText, working = false, cancellableWork = false, draftTimer, selectedRun, selectedSuggestion;
    let tab = 'suggestions', labelFilter = 'all', from = 0, to = null, hidden = false, identity;
    let screen = 'analysis', advancedOpen = false, bookOpen = false;
    let newBookName = '', createOpen = false;
    let entrySettingsOpen = false;
    let flushPromise = Promise.resolve();
    const drafts = new Map();
    let resultsFilter = 'all', resultsPage = 0;

    // Closing the view never owns the lifetime of a background request.
    function syncActivity() {
        if (!dialog?.open) return;
        const auto = host.automationActivity?.();
        const activity = controller.activity ?? auto;
        activityRow.hidden = !activity;
        activityText.textContent = activity ? `${auto ? 'Автоанализ' : 'Анализ'} · №${activity.start}–${activity.end} · ${activity.stage}` : '';
        if (activity || working) dialog.setAttribute('aria-busy', 'true');
        else dialog.removeAttribute('aria-busy');
        cancelControl.hidden = !(controller.abort || cancellableWork);
        if (activity || working) for (const control of body.querySelectorAll('button,input,select,textarea')) control.disabled = true;
    }

    function say(message, error = false) {
        if (!status) return;
        status.textContent = message; status.classList.toggle('pc-error', error);
    }

    function flush() {
        clearTimeout(draftTimer);
        const work = async () => {
            for (const [id, draft] of drafts) {
                await controller.edit(draft.run, id, draft.patch, draft.context);
                // Do not erase a newer keystroke that arrived during the save.
                if (drafts.get(id) === draft) drafts.delete(id);
            }
        };
        flushPromise = flushPromise.then(work, work);
        return flushPromise;
    }

    function draft(context, run, suggestion, patch) {
        const previous = drafts.get(suggestion.id)?.patch ?? {};
        drafts.set(suggestion.id, { context, run: run.id, patch: { ...previous, ...patch } });
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => { if (!working) flush().catch(error => say(error.message, true)); }, 450);
    }

    async function act(work, done, cancellable = false) {
        if (working || controller.busy || host.automationActivity?.()) return;
        working = true;
        cancellableWork = cancellable;
        if (cancelControl) cancelControl.hidden = !cancellable;
        dialog?.setAttribute('aria-busy', 'true');
        for (const control of body?.querySelectorAll('button,input,select,textarea') ?? []) control.disabled = true;
        try { await flush(); await work(); if (done) say(done); }
        catch (error) { say(error instanceof Error ? error.message : 'Операция не выполнена.', true); }
        finally { working = false; cancellableWork = false; await render(); syncActivity(); }
    }

    async function close() {
        try { await flush(); } catch (error) { say(error.message, true); return; }
        dialog?.close(); dialog?.remove(); dialog = null;
    }

    function showSettings(openBook = false) {
        if (working) return;
        screen = 'settings'; bookOpen = openBook;
        say('Настройки сохраняются автоматически.'); void render();
    }

    function showAnalysis() {
        if (working) return;
        screen = 'analysis'; say('Изменения сохраняются после подтверждения.'); void render();
    }

    function iconButton(symbol, label, action) {
        const control = button(symbol, action);
        control.classList.add('pc-icon-button'); control.setAttribute('aria-label', label); control.title = label;
        return control;
    }

    function settingsPanel(context) {
        const config = host.settings();
        const section = el('section', undefined, 'pc-settings-screen');
        const back = button('← К анализу', showAnalysis); back.classList.add('pc-text-button');
        section.append(back, el('h2', 'Подключение'));
        const source = select([['current', 'Текущее подключение'], ['profile', 'Профиль подключения'], ['custom', 'Отдельный API']], config.mode);
        source.onchange = () => { host.saveSettings({ mode: source.value }); void render(); };
        section.append(field('Тип подключения', source));
        const form = el('div', undefined, 'pc-provider-form'); section.append(form);
        if (config.mode === 'current') {
            form.append(el('p', 'Используется подключение основного чата.', 'pc-muted'), el('p', host.currentModel(), 'pc-current-model'));
        }
        if (config.mode === 'profile') {
            const profiles = select([['', 'Выберите профиль'], ...host.profiles().map(item => [item.id, `${item.name} · ${item.model || 'модель не указана'}`])], config.profileId);
            profiles.onchange = () => { host.saveSettings({ profileId: profiles.value }); void render(); };
            const row = el('div', undefined, 'pc-input-action');
            row.append(field('Connection Manager', profiles), iconButton('↻', 'Обновить профили', () => void render())); form.append(row);
        }
        if (config.mode === 'custom') {
            const url = input(config.url, 'url'); url.placeholder = 'https://example.com/v1';
            url.onchange = () => { loadedModels = []; host.saveSettings({ url: url.value.trim() }); };
            const key = input(host.getKey(), 'password'); key.autocomplete = 'off'; key.oninput = () => host.setKey(key.value);
            const model = input(config.model); model.setAttribute('list', 'pc-models');
            model.onchange = () => { host.saveSettings({ model: model.value.trim() }); void render(); };
            const models = el('datalist'); models.id = 'pc-models';
            form.append(field('URL API', url), field('API-ключ', key), el('p', 'Ключ хранится до перезагрузки страницы.', 'pc-muted'));
            const modelRow = el('div', undefined, 'pc-input-action'); modelRow.append(field('Модель', model));
            modelRow.append(iconButton('↻', 'Загрузить модели', () => {
                // Snapshot changed fields before disabling controls.
                host.saveSettings({ url: url.value.trim(), model: model.value.trim() });
                const abort = new AbortController();
                const timer = setTimeout(() => abort.abort(new Error('Время ожидания списка моделей истекло.')), host.settings().timeout * 1000);
                void act(async () => {
                    controller.abort = abort;
                    try {
                        const ids = await listModels(host.settings(), host.getKey(), abort.signal, host.fetch);
                        // Render after act, keeping loaded IDs for the next settings panel.
                        loadedModels = ids;
                    } finally { clearTimeout(timer); controller.abort = null; }
                }, 'Список моделей загружен. Это не проверка генерации.', true);
            })); form.append(modelRow, models);
            for (const id of loadedModels) { const option = el('option'); option.value = id; models.append(option); }
            if (loadedModels.length) {
                const picker = select([['', 'Выберите модель'], ...loadedModels.map(id => [id, id])], config.model);
                picker.onchange = () => { host.saveSettings({ model: picker.value }); void render(); };
                form.append(field('Доступные модели', picker));
            }
            const help = el('details', undefined, 'pc-api-help');
            help.append(el('summary', 'О подключении'), el('p', 'OpenAI-совместимый API с разрешённым CORS. Если список моделей недоступен, введите модель вручную. Ключ не сохраняется в настройках и журнале.', 'pc-muted'));
            form.append(help);
        }
        const advanced = el('details', undefined, 'pc-settings-section');
        advanced.open = advancedOpen; advanced.ontoggle = () => { if (advanced.isConnected) advancedOpen = advanced.open; };
        advanced.append(el('summary', 'Дополнительно'));
        const limits = el('div', undefined, 'pc-limits'); advanced.append(limits);
        for (const [name, title, min, max] of [['timeout', 'Тайм-аут, с', 15, 600], ['maxTokens', 'Ответ, токены', 256, 32000], ['budget', 'Контекст, токены', 1024, 2000000]]) {
            const value = input(config[name], 'number'); value.min = min; value.max = max;
            value.onchange = () => { host.saveSettings({ [name]: value.value }); void render(); };
            limits.append(field(title, value));
        }
        advanced.append(el('p', 'Контекст — общий бюджет входа и ответа. Оценка использует токенизатор ST; для другой модели бюджет задаётся вручную.', 'pc-muted'));
        section.append(advanced);
        const block = title => {
            const details = el('details', undefined, 'pc-settings-section'); details.append(el('summary', title)); section.append(details);
            const content = el('div', undefined, 'pc-provider-form'); details.append(content); return content;
        };
        const entries = block('Параметры записей');
        const orderMode = select([['manual', 'Вручную'], ['auto', 'Автоматически по номеру раздела'], ['reverse', 'Обратный порядок']], config.entryOrderMode ?? 'manual');
        orderMode.onchange = () => { host.saveSettings({ entryOrderMode: orderMode.value }); void render(); };
        entries.parentElement.open = entrySettingsOpen;
        entries.parentElement.ontoggle = () => { if (entries.isConnected) entrySettingsOpen = entries.parentElement.open; };
        entries.append(field('Приоритет новых записей', orderMode));
        if (config.entryOrderMode !== 'auto') {
            const reverse = config.entryOrderMode === 'reverse';
            const value = input(reverse ? config.entryReverseStart ?? 9999 : config.entryOrderValue ?? 100, 'number'); value.min = 0; value.max = 9999; value.step = 1;
            value.onchange = () => host.saveSettings({ [reverse ? 'entryReverseStart' : 'entryOrderValue']: value.value });
            entries.append(field(reverse ? 'Начальное значение приоритета' : 'Приоритет', value));
        }
        entries.append(el('p', 'Автоматически: 1, 2, 3… по числу разделов персоны в книге. Обратный порядок: от заданного числа вниз. При обновлении приоритет раздела сохраняется.', 'pc-muted'));
        const events = input('', 'checkbox'); events.checked = config.saveEvents === true;
        events.onchange = () => host.saveSettings({ saveEvents: events.checked });
        const eventsLabel = el('label', undefined, 'pc-check'); eventsLabel.append(events, el('span', 'Сохранять значимые события персоны')); entries.append(eventsLabel);
        entries.append(el('p', 'Выключено: сохраняются новые факты и изменения персоны, без хроники сюжета. Включено: также важные события её личной истории.', 'pc-muted'));
        for (const [name, title] of [['entryConstant', 'Постоянная активация'], ['entryVectorized', 'Векторизация'], ['entryExcludeRecursion', 'Не активировать при рекурсивном сканировании'], ['entryPreventRecursion', 'Не запускать рекурсию из записи']]) {
            const check = input('', 'checkbox'); check.checked = Boolean(config[name]); check.onchange = () => host.saveSettings({ [name]: check.checked });
            const label = el('label', undefined, 'pc-check'); label.append(check, el('span', title)); entries.append(label);
        }
        entries.append(el('p', 'Обычная активация — постоянная и векторизация выключены. Эти значения применяются к новым записям; у существующих сохраняются свои.', 'pc-muted'));
        const prompts = block('Промпт сборки и ключей');
        const prompt = el('textarea'); prompt.value = config.prompt || defaultPrompt(); prompt.rows = 10;
        prompt.onchange = () => host.saveSettings({ prompt: prompt.value });
        prompts.append(field('Инструкции модели', prompt), el('p', 'Текст записи — на языке описания персоны; regex-ключи — RU и EN. Формат JSON и проверка цитат обязательны.', 'pc-muted'), button('Восстановить промпт', () => { host.saveSettings({ prompt: '' }); prompt.value = defaultPrompt(); }));
        const auto = block('Автосоздание записей');
        const enabled = input('', 'checkbox'); enabled.checked = Boolean(config.autoEnabled && context && config.autoContext === context.identity); enabled.disabled = !context;
        enabled.onchange = () => host.saveSettings({ autoEnabled: enabled.checked, autoContext: context?.identity || '' });
        const enableLabel = el('label', undefined, 'pc-check'); enableLabel.append(enabled, el('span', 'Автоматический анализ этого чата')); auto.append(enableLabel);
        const trigger = select([['messages', 'По числу сообщений'], ['tokens', 'По числу токенов']], config.autoTrigger);
        trigger.onchange = () => host.saveSettings({ autoTrigger: trigger.value }); auto.append(field('Условие запуска', trigger));
        for (const [key, title] of [['autoMessages', 'Интервал сообщений'], ['autoTokens', 'Интервал токенов']]) {
            const value = input(config[key], 'number'); value.min = key === 'autoMessages' ? 1 : 100;
            value.onchange = () => host.saveSettings({ [key]: value.value }); auto.append(field(title, value));
        }
        const save = input('', 'checkbox'); save.checked = Boolean(config.autoSave); save.onchange = () => host.saveSettings({ autoSave: save.checked });
        const saveLabel = el('label', undefined, 'pc-check'); saveLabel.append(save, el('span', 'Автоматически сохранять проверенные находки')); auto.append(saveLabel);
        auto.append(el('p', 'Анализ запускается после ответов, когда окно закрыто. Без автосохранения находки ждут проверки. Противоречия и детали, добавленные моделью, всегда остаются на ручную проверку.', 'pc-muted'), el('p', host.automationStatus?.() || 'Выключено', 'pc-muted'), button('Сбросить ошибку автоматизации', () => { host.saveSettings({}); say('Автоматизация продолжится после следующего ответа.'); }));
        if (context) {
            const names = [...new Set([...host.books(), context.book].filter(Boolean))];
            const books = select([['', 'Выберите лорбук'], ...names.map(name => [name, name])], context.book);
            const binding = el('div', undefined, 'pc-binding');
            binding.append(field('Лорбук персоны', books), iconButton('↻', 'Обновить книги', () => void act(() => host.refreshBooks())),
                button('Привязать', () => void act(() => host.bindBook(books.value), 'Лорбук привязан к персоне.')));
            const details = el('details', undefined, 'pc-settings-section'); details.open = bookOpen || !context.book;
            details.ontoggle = () => { if (details.isConnected) bookOpen = details.open; };
            const create = el('details', undefined, 'pc-create-book'); create.open = createOpen;
            create.ontoggle = () => { if (create.isConnected) createOpen = create.open; };
            const suggested = `Persona Weaver — ${context.personaName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 60)}`;
            const name = input(newBookName || suggested); name.maxLength = 120;
            name.oninput = () => { newBookName = name.value; };
            const row = el('div', undefined, 'pc-create-book-row');
            row.append(field('Название нового лорбука', name), button('Создать и привязать', () => void act(async () => {
                await host.createBook(name.value);
                newBookName = ''; createOpen = false; bookOpen = true;
            }, 'Лорбук создан и привязан к персоне.')));
            create.append(el('summary', 'Создать лорбук'), row);
            details.append(el('summary', 'Лорбук персоны'), binding, create); section.append(details);
        }
        const actions = el('div', undefined, 'pc-settings-actions'); actions.append(button('Готово', showAnalysis, true)); section.append(actions);
        return section;
    }
    let loadedModels = [];

    async function analyze(force = false) {
        const result = await controller.analyze({ start: from, end: to, includeHidden: hidden, force,
            config: host.settings(), key: host.getKey() });
        if (result.repeated) {
            say(`${coverageNames[result.coverage.status]}: ${result.coverage.covered} из ${result.coverage.total} сообщений. Откройте прежние находки или нажмите «Повторить».`);
        } else {
            selectedRun = result.run.id; selectedSuggestion = null; tab = 'suggestions';
            resultsFilter = 'all'; resultsPage = 0;
            say(result.run.validationIssues?.length
                ? `Корректных находок: ${result.run.suggestions.length}. Не прошли проверку источников: ${result.run.validationIssues.length}. Подробности ниже; сцена не отмечена обработанной.`
                : result.run.suggestions.length ? `Найдено предложений: ${result.run.suggestions.length}. Проверьте перед сохранением.` : 'Новых устойчивых деталей нет. Сцена отмечена проанализированной.', Boolean(result.run.validationIssues?.length));
        }
    }

    async function render() {
        if (!dialog?.open) return;
        syncActivity();
        let noChat = false;
        try {
            await flush();
            if (!dialog?.open) return;
            const scroll = body.dataset.screen === screen ? body.scrollTop : 0;
            body.dataset.screen = screen;
            settingsControl?.setAttribute('aria-pressed', String(screen === 'settings'));
            let context;
            try { context = host.capture(); }
            catch (error) {
                if (screen !== 'settings') { noChat = true; throw error; }
                // Connection settings do not depend on a saved chat being open.
            }
            if (screen === 'settings') {
                body.replaceChildren(settingsPanel(context)); body.scrollTop = scroll; syncActivity(); return;
            }
            const state = await controller.state(context);
            // Keep the complete old screen visible during the asynchronous book read.
            const requestedTab = tab;
            const entryBook = requestedTab === 'entries' && context.book ? await host.readBook(context.book) : null;
            if (!dialog?.open) return;
            if (host.capture().identity !== context.identity || host.capture().book !== context.book || tab !== requestedTab || screen !== 'analysis') return;
            if (identity !== context.identity) { identity = context.identity; from = 0; to = Math.max(0, context.chat.length - 1); selectedRun = null; selectedSuggestion = null; resultsFilter = 'all'; resultsPage = 0; }
            body.replaceChildren();
            const heading = el('div', undefined, 'pc-heading');
            heading.append(el('h2', context.personaName), el('p', `Чат: ${context.chatName}`, 'pc-muted'));
            body.append(heading);
            const bookLine = el('div', undefined, 'pc-book-line');
            const bookLink = button(context.book || 'Выбрать', () => showSettings(true)); bookLink.classList.add('pc-text-button'); bookLink.title = context.book || 'Выбрать лорбук персоны';
            bookLine.append(el('span', 'Лорбук персоны', 'pc-muted'), bookLink); body.append(bookLine);
            const connection = safeConnection(host.settings(), host);
            const connectionButton = button('', () => showSettings()); connectionButton.classList.add('pc-connection');
            const connectionName = `${{ current: 'Текущее подключение', profile: connection.profile || 'Профиль', custom: 'Отдельный API' }[connection.mode]} · ${connection.model}`;
            connectionButton.append(el('span', connectionName), el('span', 'Настроить ›', 'pc-connection-action'));
            connectionButton.title = connectionName; body.append(connectionButton);
            const scene = el('section', undefined, 'pc-scene'); scene.setAttribute('aria-label', 'Выбор сцены');
            const sceneHeading = el('div', undefined, 'pc-scene-heading');
            sceneHeading.append(el('strong', 'Сцена'), el('span', Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to < context.chat.length ? `${to - from + 1} сообщ.` : 'Выберите диапазон', 'pc-muted'));
            scene.append(sceneHeading);
            const toolbar = el('div', undefined, 'pc-range-row'); toolbar.title = 'Номера сообщений начинаются с нуля. Обе границы включены.';
            const start = input(from, 'number'), end = input(to ?? Math.max(0, context.chat.length - 1), 'number');
            start.min = end.min = 0; start.max = end.max = Math.max(0, context.chat.length - 1);
            start.onchange = () => { from = Number(start.value); void render(); };
            end.onchange = () => { to = Number(end.value); void render(); };
            toolbar.append(field('От', start), el('span', '—', 'pc-range-divider'), field('До', end),
                button('Анализировать', () => void act(() => analyze(false), null, true), true));
            const include = input('', 'checkbox'); include.checked = hidden; include.onchange = () => { hidden = include.checked; void render(); };
            const includeLabel = el('label', undefined, 'pc-check'); includeLabel.append(include, el('span', 'Скрытые сообщения'));
            scene.append(toolbar);
            let coverage;
            try { coverage = rangeCoverage(context.chat, selectSources(context.chat, from, to, { includeHidden: hidden }), state.runs); }
            catch { /* Invalid/empty selection is explained when starting analysis. */ }
            const options = el('div', undefined, 'pc-scene-options');
            options.append(includeLabel, el('span', coverage ? `${coverageNames[coverage.status]}${coverage.covered ? ` · ${coverage.covered}/${coverage.total}` : ''}` : 'Диапазон не выбран', 'pc-coverage-status'));
            scene.append(options);
            const coverageBar = el('div', undefined, 'pc-coverage');
            const next = button('Следующий необработанный участок →', () => {
                try {
                    const sources = selectSources(context.chat, 0, context.chat.length - 1, { includeHidden: hidden });
                    const covered = new Set(rangeCoverage(context.chat, sources, state.runs).ids);
                    const missing = sources.filter(source => !covered.has(source.id));
                    if (!missing.length) { say('Все доступные сообщения проанализированы.'); return; }
                    from = missing[0].id; to = from;
                    for (const source of sources.filter(source => source.id > from)) {
                        if (covered.has(source.id)) break;
                        to = source.id;
                    }
                    void render();
                } catch (error) { say(error.message, true); }
            }); next.classList.add('pc-text-button'); coverageBar.append(next);
            if (coverage?.covered) {
                const repeat = button('Повторить', () => void act(() => analyze(true), null, true)); repeat.classList.add('pc-text-button'); coverageBar.append(repeat);
            }
            scene.append(coverageBar); body.append(scene);
            const tabs = el('div', undefined, 'pc-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Разделы Persona Weaver');
            for (const [id, title] of [['suggestions', 'Находки'], ['entries', 'Записи'], ['runs', 'Сцены'], ['history', 'История']]) {
                const control = button(title, () => { tab = id; void render(); });
                control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(tab === id)); tabs.append(control);
            }
            body.append(tabs);
            const panel = el('section', undefined, 'pc-panel'); panel.setAttribute('aria-label', 'Содержимое выбранного раздела'); body.append(panel);
            if (tab === 'suggestions') renderSuggestions(panel, context, state);
            if (tab === 'runs') renderRuns(panel, context, state);
            if (tab === 'history') renderHistory(panel, state);
            if (tab === 'entries') {
                if (!context.book) panel.append(el('p', 'Сначала привяжите лорбук к персоне.'));
                else renderEntries(panel, context, entryBook);
            }
            body.scrollTop = scroll;
            syncActivity();
        } catch (error) {
            say(error.message, true);
            if (body && (noChat || !body.childElementCount)) {
                const empty = el('div', undefined, 'pc-empty');
                empty.append(el('strong', 'Откройте чат и выберите персону'), el('p', 'Подключение можно настроить заранее.'));
                body.replaceChildren(empty, button('Настройки подключения', () => showSettings()));
            }
        }
    }

    function resultControls(panel, state) {
        const filter = select([['all', 'Все'], ['findings', 'С находками'], ['pending', 'Ожидают решения']], resultsFilter);
        filter.onchange = () => { resultsFilter = filter.value; resultsPage = 0; selectedRun = null; selectedSuggestion = null; void render(); };
        panel.append(field('Показать результаты', filter));
        const result = resultPage(state.runs, resultsFilter, resultsPage); resultsPage = result.page;
        const nav = el('div', undefined, 'pc-actions'); nav.setAttribute('aria-label', 'Страницы результатов');
        nav.append(el('span', `Результатов: ${result.total} · ${result.page + 1}/${result.pages}`, 'pc-muted'));
        if (result.pages > 1) {
            for (const [label, step] of [['Новее', -1], ['Раньше', 1]]) {
                const control = button(label, () => { resultsPage += step; selectedRun = null; selectedSuggestion = null; void render(); });
                control.disabled = result.page + step < 0 || result.page + step >= result.pages; nav.append(control);
            }
        }
        panel.append(nav);
        return result.runs;
    }

    function renderSuggestions(panel, context, state) {
        if (!state.runs.length) {
            const empty = el('div', undefined, 'pc-empty');
            empty.append(el('strong', 'Новых находок пока нет'), el('p', 'Выберите сцену — здесь появятся детали для проверки.')); panel.append(empty); return;
        }
        const visible = resultControls(panel, state);
        if (!visible.length) { panel.append(el('p', 'Нет результатов для выбранного фильтра.', 'pc-empty')); return; }
        const run = visible.find(item => item.id === selectedRun) ?? visible[0]; selectedRun = run.id;
        const picker = select(visible.map(item => [item.id, `№${item.start}–${item.end} · ${new Date(item.date).toLocaleString()} · ${item.suggestions.length} находок`]), run.id);
        picker.onchange = () => { selectedRun = picker.value; selectedSuggestion = null; void render(); }; panel.append(field('Результат анализа', picker));
        if (run.validationIssues?.length) {
            const issues = el('details', undefined, 'pc-warning pc-validation-issues'); issues.open = true;
            issues.append(el('summary', `Не прошли проверку источников: ${run.validationIssues.length}`),
                el('p', 'Эти предложения не добавлены в очередь и не могут быть сохранены. Корректные находки доступны ниже. Сцена не отмечена обработанной.'));
            for (const issue of run.validationIssues) {
                const row = el('section', undefined, 'pc-record');
                row.append(el('h3', issue.title), el('p', `${issue.sourceId ? `Источник ${issue.sourceId}` : `Сообщение №${issue.messageId ?? '?'}`} · ${issue.reason}`), el('blockquote', issue.quote));
                const source = run.sources.find(item => item.id === issue.messageId);
                if (source) {
                    const original = el('details'); original.append(el('summary', 'Исходное сообщение'), el('pre', source.text, 'pc-entry-text')); row.append(original);
                }
                issues.append(row);
            }
            panel.append(issues);
        }
        if (!run.suggestions.length) { panel.append(el('p', run.validationIssues?.length ? 'Нет находок, прошедших проверку источников. Можно повторить анализ с дословными цитатами.' : 'В этой сцене новых устойчивых деталей не найдено.', 'pc-empty')); return; }
        const layout = el('div', undefined, 'pc-review');
        const list = el('nav', undefined, 'pc-list'); list.setAttribute('aria-label', 'Найденные детали');
        const current = run.suggestions.find(item => item.id === selectedSuggestion) ?? run.suggestions.find(item => item.status === 'pending') ?? run.suggestions[0];
        const prepared = state.history.find(item => item.status === 'prepared' && item.suggestionId === current.id);
        const editable = current.status === 'pending' && !prepared;
        selectedSuggestion = current.id;
        for (const item of run.suggestions) {
            const control = button('', () => {
                selectedSuggestion = item.id;
                void render().then(() => {
                    body.querySelector('.pc-review')?.classList.add('pc-show-detail');
                    body.querySelector('.pc-detail')?.scrollIntoView({ block: 'start' });
                });
            });
            control.classList.add('pc-item'); control.setAttribute('aria-pressed', String(item.id === current.id));
            control.append(el('strong', item.title), el('small', `${statusNames[item.status]}${item.conflict ? ' · Противоречие' : ''}`)); list.append(control);
        }
        const detail = el('article', undefined, 'pc-detail');
        const back = button('← К списку', () => { layout.classList.remove('pc-show-detail'); list.scrollIntoView({ block: 'start' }); }); back.classList.add('pc-back'); detail.append(back);
        detail.append(el('div', CATEGORIES[current.category] ?? current.categoryName, 'pc-tag'), el('h3', current.title), el('p', current.reason, 'pc-reason'));
        if (current.categoryProposal && editable) {
            const proposal = el('section', undefined, 'pc-warning');
            proposal.append(el('strong', 'Предложение новой категории'), el('p', current.categoryProposal.reason), el('p', 'Всегда требует ручного подтверждения. При переносе в существующий раздел проверьте и отредактируйте собранный текст ниже.'));
            const name = input(current.categoryName ?? current.categoryProposal.name);
            const destinations = new Map(Object.entries(SECTION_NAMES));
            for (const entry of Object.values(run.baselines)) if (entry.personaCanon.categoryName) destinations.set(entry.personaCanon.category, entry.personaCanon.categoryName);
            const destination = select([['new', 'Новая категория'], ...destinations], current.categoryName && current.target === null ? 'new' : current.category);
            proposal.append(field('Название категории', name), field('Раздел для сведений', destination), button('Обновить предложение', () => void act(() => controller.configureCategory(run.id, current.id, { name: name.value, destination: destination.value }), 'Предложение обновлено. Проверьте текст перед сохранением.')));
            detail.append(proposal);
        }
        if (current.conflict) detail.append(el('p', 'Есть противоречие. Сравните источники и вручную отредактируйте итоговый текст перед принятием.', 'pc-warning'));
        if (current.modelAuthored) detail.append(el('p', 'Среди источников есть деталь, добавленная моделью. Проверьте, подходит ли она персоне.', 'pc-warning'));
        const diff = el('div', undefined, 'pc-diff');
        const before = el('section'); before.append(el('span', 'Сейчас', 'pc-muted'), el('p', current.before ?? 'Новой записи пока нет.', 'pc-before'));
        const text = el('textarea'); text.value = current.content; text.rows = 6; text.readOnly = !editable;
        text.oninput = () => draft(context, run, current, { content: text.value });
        diff.append(before, field('Предлагаемый текст', text)); detail.append(diff);
        const label = select([['chat', `Из чата: ${run.chatName}`], ['general', 'Общее']], current.label); label.disabled = !editable;
        label.title = 'Метка не ограничивает активацию записи.';
        label.onchange = () => draft(context, run, current, { label: label.value }); detail.append(field('Метка', label));
        if (editable) {
            const keys = el('textarea'); keys.rows = 3; keys.value = current.keywords; keys.className = 'pc-key-editor'; keys.oninput = () => draft(context, run, current, { keywords: keys.value });
            keys.title = 'Каждый regex-ключ целиком на отдельной строке'; detail.append(field('Ключи активации RU / EN', keys));
            for (const [name, title] of [['constant', 'Постоянная активация'], ['vectorized', 'Векторизация'], ['excludeRecursion', 'Не активировать рекурсией'], ['preventRecursion', 'Не запускать рекурсию']]) {
                const value = input('', 'checkbox'); value.checked = Boolean(current[name]); value.onchange = () => draft(context, run, current, { [name]: value.checked });
                const check = el('label', undefined, 'pc-check'); check.append(value, el('span', title)); detail.append(check);
            }
        }
        const evidence = el('details', undefined, 'pc-evidence'); evidence.append(el('summary', 'Источники и авторство'));
        for (const source of current.evidence) {
            evidence.append(el('blockquote', source.quote), button(`Сообщение №${source.messageId} · ${source.author === 'user' ? 'Пользователь' : 'Модель'}`, () => {
                try { host.revealMessage(source.messageId); void close(); } catch (error) { say(error.message, true); }
            }));
        }
        detail.append(evidence);
        if (prepared) detail.append(el('p', 'Сохранение не завершено. Проверьте операцию в разделе «История» перед изменением предложения.', 'pc-warning'));
        if (editable) {
            const actions = el('div', undefined, 'pc-actions');
            actions.append(button('Принять и сохранить', () => {
                if (current.conflict && !confirm('Вы проверили противоречие и хотите сохранить предложенный текст?')) return;
                void act(() => controller.apply(run.id, current.id), 'Правка сохранена в лорбук.');
            }, true), button('Отклонить', () => void act(() => controller.edit(run.id, current.id, { status: 'rejected' }), 'Предложение отклонено. Лорбук не изменён.')));
            detail.append(actions);
        }
        layout.append(list, detail); panel.append(layout);
    }

    function renderRuns(panel, context, state) {
        if (!state.runs.length) panel.append(el('p', 'Успешных анализов пока нет.', 'pc-empty'));
        const visible = resultControls(panel, state);
        if (state.runs.length && !visible.length) panel.append(el('p', 'Нет результатов для выбранного фильтра.', 'pc-empty'));
        for (const run of visible) {
            const row = el('section', undefined, 'pc-record');
            let current = false;
            try { current = rangeCoverage(context.chat, selectSources(context.chat, run.start, run.end, { includeHidden: run.includeHidden }), [run]).status === 'done'; } catch { /* Deleted range. */ }
            row.append(el('h3', `№${run.start}–${run.end} · ${run.validationIssues?.length ? 'Есть ошибки источников' : current ? 'Проанализирован' : 'Источники изменились'}`),
                el('p', `${new Date(run.date).toLocaleString()} · ${run.connection.model} · ${run.inputTokens} токенов входа (оценка ST)`, 'pc-muted'),
                button(`Открыть находки (${run.suggestions.length})`, () => { selectedRun = run.id; selectedSuggestion = null; tab = 'suggestions'; void render(); })); panel.append(row);
        }
    }

    function renderHistory(panel, state) {
        if (!state.history.length) panel.append(el('p', 'Изменений лорбука пока нет.', 'pc-empty'));
        for (const item of [...state.history].reverse()) {
            const row = el('section', undefined, 'pc-record');
            row.append(el('h3', `${item.after?.comment ?? item.before?.comment ?? 'Запись'} · ${historyStatus(item)}`),
                el('p', `${new Date(item.date).toLocaleString()} · ${item.book} · ${{ apply: 'Правка', undo: 'Откат', label: 'Метка' }[item.kind]}`, 'pc-muted'));
            const versions = el('details'); versions.append(el('summary', 'Посмотреть сохранённые версии'));
            versions.append(el('pre', JSON.stringify({ before: item.before, after: item.after }, null, 2))); row.append(versions);
            if (item.status === 'prepared') row.append(button('Проверить / повторить незавершённую запись', () => void act(() => controller.recover(item.id), 'Состояние операции проверено.')));
            if (item.status === 'applied' && !item.undoOf) row.append(button(item.before === null ? 'Удалить созданную запись' : 'Восстановить предыдущую версию', () => {
                if (confirm(item.before === null ? 'Удалить запись, созданную этой операцией? Если её меняли позднее, удаление будет заблокировано.' : 'Восстановить предыдущую версию? Более поздние изменения не будут затёрты.')) void act(() => controller.undo(item.id), 'Операция отменена.');
            })); panel.append(row);
        }
        const download = button('Экспортировать журнал этого чата', () => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
            const link = el('a'); link.href = url; link.download = 'persona-canon-journal.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }); panel.append(download);
    }

    function renderEntries(panel, context, book) {
        const filter = select([['all', 'Все записи'], ['general', 'С меткой «Общее»'], ['chat', 'Из текущего чата']], labelFilter);
        filter.title = 'Фильтр списка не влияет на активацию записей.';
        filter.onchange = () => { labelFilter = filter.value; void render(); }; panel.append(field('Показать', filter));
        const entries = managedEntries(book, context.persona).filter(entry => labelFilter === 'all' || entry.personaCanon.origins.some(origin => labelFilter === 'general' ? origin.kind === 'general' : origin.kind === 'chat' && origin.context === context.identity));
        if (!entries.length) panel.append(el('p', 'Управляемых записей с такой меткой пока нет.', 'pc-empty'));
        for (const entry of entries) {
            const row = el('section', undefined, 'pc-record');
            row.append(el('h3', entry.comment), el('p', entryLabels(entry).join(' · '), 'pc-tag'), el('p', entry.content, 'pc-entry-text'));
            const details = el('details'); details.append(el('summary', 'Метки отдельных добавлений'));
            for (const origin of entry.personaCanon.origins) {
                const picker = select([['general', 'Общее'], ['chat', `Из чата: ${origin.chatName}`]], origin.kind);
                picker.onchange = () => void act(() => controller.relabel(String(entry.uid), origin.id, picker.value), 'Метка обновлена. Активация записи не изменилась.');
                details.append(field(new Date(origin.date).toLocaleString(), picker));
            }
            row.append(details); panel.append(row);
        }
    }

    controller.subscribe(() => { syncActivity(); if (!controller.busy && !working) void render(); });
    subscribe(() => { syncActivity(); if (!working) void render(); });
    return async function open() {
        if (dialog?.open) { dialog.focus(); return; }
        dialog = el('dialog'); dialog.id = 'persona-canon-dialog'; dialog.setAttribute('aria-label', 'Persona Weaver');
        const bar = el('header', undefined, 'pc-titlebar');
        settingsControl = iconButton('⚙', 'Настройки', () => screen === 'settings' ? showAnalysis() : showSettings());
        bar.append(el('strong', 'Persona Weaver'), iconButton('↻', 'Обновить', () => void render()), settingsControl, iconButton('×', 'Закрыть', () => void close()));
        body = el('div', undefined, 'pc-body'); status = el('footer', 'Изменения сохраняются после подтверждения.', 'pc-status');
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        activityRow = el('div', undefined, 'pc-activity'); activityRow.hidden = true;
        activityRow.setAttribute('role', 'status'); activityRow.setAttribute('aria-live', 'polite');
        const spinner = el('span', undefined, 'pc-spinner'); spinner.setAttribute('aria-hidden', 'true');
        activityText = el('span'); activityRow.append(spinner, activityText);
        cancelControl = button('Остановить', () => controller.cancel()); cancelControl.setAttribute('aria-label', 'Отменить запрос'); cancelControl.classList.add('pc-stop'); cancelControl.hidden = true; bar.append(cancelControl);
        dialog.append(bar, activityRow, body, status); dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
        document.body.append(dialog); dialog.showModal(); await render();
    };
}
