export function assertCompletionAllowed(data) {
    const choice = data?.choices?.[0];
    if (choice?.message?.refusal || ['content_filter', 'refusal'].includes(choice?.finish_reason) || data?.stop_reason === 'refusal') {
        const error = new Error('Провайдер сообщил об отказе или фильтрации ответа. Сцена не отмечена обработанной.');
        error.code = 'PERSONA_REFUSAL'; throw error;
    }
}

export function apiBase(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Введите полный URL API.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Нужен HTTP(S) URL без пароля, параметров и фрагмента.');
    }
    return url.href.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
}

export function safeConnection(config, host) {
    if (config.mode === 'custom') return { mode: 'custom', model: config.model || 'не выбрана' };
    if (config.mode === 'profile') {
        const profile = host.profiles().find(item => item.id === config.profileId);
        return { mode: 'profile', model: profile?.model || 'не выбрана', profile: profile?.name || 'не выбран' };
    }
    return { mode: 'current', model: host.currentModel() };
}

export async function listModels(config, key, signal, fetcher = fetch) {
    let response;
    try {
        response = await fetcher(`${apiBase(config.url)}/models`, { signal,
            headers: key ? { Authorization: `Bearer ${key}` } : {} });
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new Error('Не удалось получить модели. Проверьте URL, доступность API и CORS. Модель можно ввести вручную.');
    }
    if (!response.ok) throw new Error(`Список моделей: HTTP ${response.status}. Модель можно ввести вручную.`);
    let data;
    try { data = await response.json(); } catch { throw new Error('Список моделей содержит невалидный JSON. Введите модель вручную.'); }
    signal.throwIfAborted();
    if (!Array.isArray(data?.data)) throw new Error('API не вернул список data[]. Введите модель вручную.');
    return [...new Set(data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.length < 300))].sort();
}

export async function requestAnalysis(host, config, key, prompt, controller) {
    const signal = controller.signal;
    signal.throwIfAborted();
    const timeout = setTimeout(() => controller.abort(new Error('Превышено время ожидания анализа.')), config.timeout * 1000);
    try {
        let result;
        if (config.mode === 'custom') {
            if (!config.model.trim()) throw new Error('Выберите или введите модель отдельного API.');
            let response;
            try {
                response = await host.fetch(`${apiBase(config.url)}/chat/completions`, {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
                    body: JSON.stringify({ model: config.model, messages: prompt, stream: false, temperature: 0.2, max_tokens: config.maxTokens }),
                });
            } catch {
                signal.throwIfAborted();
                throw new Error('Отдельный API недоступен. Проверьте URL, соединение и разрешение CORS.');
            }
            if (!response.ok) throw new Error(`Отдельный API: HTTP ${response.status}. Подключение не переключалось.`);
            let data;
            try { data = await response.json(); } catch { throw new Error('Отдельный API вернул невалидный JSON ответа.'); }
            assertCompletionAllowed(data);
            if (data?.choices?.[0]?.finish_reason === 'length') throw new Error('Ответ обрезан. Увеличьте лимит ответа или уменьшите диапазон.');
            result = data?.choices?.[0]?.message?.content;
        } else if (config.mode === 'profile') {
            if (!host.profiles().some(item => item.id === config.profileId)) throw new Error('Выбранный профиль недоступен. Обновите список профилей.');
            try { result = await host.profileRequest(config.profileId, prompt, config.maxTokens, signal); }
            catch (error) { signal.throwIfAborted(); if (error?.code === 'PERSONA_REFUSAL') throw error; throw new Error('Ошибка выбранного профиля. Проверьте его подключение и модель.'); }
        } else {
            try { result = await host.currentRequest(prompt, config.maxTokens, signal); }
            catch (error) { signal.throwIfAborted(); if (error?.code === 'PERSONA_REFUSAL') throw error; throw new Error('Ошибка текущего подключения. Проверьте соединение SillyTavern.'); }
        }
        signal.throwIfAborted();
        const text = typeof result === 'string' ? result : result?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Модель не вернула итоговый текст. Проверьте лимит ответа.');
        return text;
    } finally { clearTimeout(timeout); }
}
