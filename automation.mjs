import { rangeCoverage, selectSources } from './core.mjs';

export class CanonAutomation {
    constructor(controller, host) { this.controller = controller; this.host = host; this.running = false; this.blocked = false; this.status = 'Выключено'; }
    resume() { this.blocked = false; }
    async tick() {
        const config = this.host.settings();
        if (!config.autoEnabled || this.running || this.controller.busy || this.host.isGenerating() || this.blocked) return;
        this.running = true;
        try {
            const context = this.host.capture();
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
            const { run } = await this.controller.analyze({ start: batch[0].id, end: batch.at(-1).id, includeHidden: false, config, key: this.host.getKey() });
            if (!run) return;
            if (config.autoSave) {
                for (const suggestion of run.suggestions) {
                    if (suggestion.conflict || suggestion.modelAuthored) continue;
                    if (!this.host.settings().autoEnabled || !this.host.settings().autoSave) break;
                    if (this.host.capture().identity !== context.identity) break;
                    await this.controller.apply(run.id, suggestion.id);
                }
            }
            this.status = `Готово · ${run.suggestions.length} находок`;
        } catch (error) {
            this.blocked = true;
            this.status = `Остановлено: ${error.message}`;
        } finally { this.running = false; this.host.onUpdate?.(); }
    }
}
