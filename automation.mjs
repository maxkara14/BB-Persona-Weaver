import { rangeCoverage, selectSources } from './core.mjs';

export class CanonAutomation {
    constructor(controller, host) { this.controller = controller; this.host = host; this.running = false; this.blocked = false; this.status = 'Выключено'; }
    resume() { this.blocked = false; }
    notify(event) {
        // Notifications must never change the outcome of analysis or saving.
        try { this.host.notify?.(event); } catch { /* Toast UI is best effort. */ }
    }
    async summary(context, run, saved) {
        if (!run) return { found: 0, saved, pending: 0, uncertain: 0 };
        try {
            const state = await this.controller.state(context);
            const current = state.runs.find(item => item.id === run.id) ?? run;
            const uncertain = new Set(state.history.filter(item => item.runId === run.id && item.status === 'prepared').map(item => item.suggestionId));
            return { found: current.suggestions.length,
                saved: current.suggestions.filter(item => item.status === 'applied').length,
                pending: current.suggestions.filter(item => item.status === 'pending' && !uncertain.has(item.id)).length,
                uncertain: uncertain.size };
        } catch { return { found: run.suggestions.length, saved, unverified: true }; }
    }
    async tick() {
        const config = this.host.settings();
        if (!config.autoEnabled || this.running || this.controller.busy || this.host.isGenerating() || this.blocked) return;
        this.running = true;
        let context, run, saved = 0;
        try {
            context = this.host.capture();
            if (config.autoContext !== context.identity || !context.chat.length) return;
            const state = await this.controller.state(context);
            const sources = selectSources(context.chat, 0, context.chat.length - 1);
            const covered = new Set(rangeCoverage(context.chat, sources, state.runs).ids);
            const first = sources.findIndex(source => !covered.has(source.id));
            if (first < 0) return;
            const batch = [];
            for (const source of sources.slice(first)) { if (covered.has(source.id)) break; batch.push(source); }
            const reached = config.autoTrigger === 'tokens'
                ? await this.host.countTokens(batch.map(item => item.text).join('\n')) >= config.autoTokens
                : batch.length >= config.autoMessages;
            this.controller.assertContext(context);
            if (!reached) { this.status = `Ожидание порога · ${batch.length} сообщ.`; return; }
            this.status = 'Анализ сцены…';
            this.notify({ type: 'started', start: batch[0].id, end: batch.at(-1).id });
            ({ run } = await this.controller.analyze({ start: batch[0].id, end: batch.at(-1).id, includeHidden: false, config, key: this.host.getKey() }));
            if (!run) { this.notify({ type: 'skipped' }); return; }
            if (config.autoSave) {
                for (const suggestion of run.suggestions) {
                    if (suggestion.conflict || suggestion.modelAuthored) continue;
                    if (!this.host.settings().autoEnabled || !this.host.settings().autoSave) break;
                    if (this.host.capture().identity !== context.identity) break;
                    await this.controller.apply(run.id, suggestion.id);
                    saved++;
                }
            }
            this.status = `Готово · ${run.suggestions.length} находок`;
            this.notify({ type: 'completed', ...await this.summary(context, run, saved) });
        } catch (error) {
            this.blocked = true;
            const message = error instanceof Error ? error.message : 'Не удалось выполнить автоматизацию.';
            this.status = `Остановлено: ${message}`;
            this.notify({ type: 'failed', error: message, ...await this.summary(context, run, saved) });
        } finally { this.running = false; this.host.onUpdate?.(); }
    }
}
