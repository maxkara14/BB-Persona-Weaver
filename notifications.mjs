export function showAutomationNotice(event, toast, secret = '') {
    if (!toast) return;
    const totals = event.unverified ? `Подтверждённо сохранено записей: ${event.saved ?? 0}. Остальные результаты не удалось проверить; откройте «Историю».`
        : `Сохранено записей: ${event.saved ?? 0}. Ожидают проверки: ${event.pending ?? 0}.`
        + (event.uncertain ? ` Неподтверждённых операций: ${event.uncertain}. Проверьте «Историю».` : '');
    let level, message, title = 'Persona Weaver';
    switch (event.type) {
        case 'book_created': level = 'success'; title = 'Persona Weaver · Лорбук создан'; message = `Создан и привязан к персоне лорбук «${event.book}».`; break;
        case 'manual_completed': level = 'success'; title = 'Persona Weaver · Анализ завершён'; message = event.found ? `Найдено дополнений: ${event.found}. Откройте «Находки» для проверки и сохранения.` : 'Изменений не требуется. Сцена отмечена обработанной.'; break;
        case 'started': level = 'info'; message = `Начат автоматический анализ сцены №${event.start}–${event.end}.`; break;
        case 'skipped': level = 'info'; message = 'Сцена уже обработана. Повторный анализ не выполнялся.'; break;
        case 'completed':
            title = 'Persona Weaver · Автоанализ завершён';
            level = event.saved && !event.invalid ? 'success' : 'info';
            message = event.invalid
                ? `Анализ завершён с ошибками проверки: ${event.invalid}. ${totals} Подробности — в «Находках». Автоматические повторы приостановлены; после проверки сбросьте ошибку автоматизации.`
                : event.found ? `Автоматический анализ завершён. ${totals}` : 'Автоматический анализ завершён. Новых устойчивых деталей нет.';
            break;
        case 'failed':
            level = 'error'; message = `Автоматизация остановлена: ${event.error}`;
            if (event.found || event.saved || event.uncertain) message += ` ${totals}`;
            break;
        default: return;
    }
    if (secret) message = message.split(secret).join('[скрыто]');
    try { toast[level](message, title, {
        escapeHtml: true, closeButton: true,
        timeOut: level === 'error' ? 0 : event.type === 'started' ? 4000 : 9000,
        extendedTimeOut: level === 'error' ? 0 : 2000,
    }); } catch { /* Notifications must not affect confirmed operations. */ }
}
