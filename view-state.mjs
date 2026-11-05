// Display limits never prune the journal or change scene coverage.
export function resultPage(runs, filter = 'all', page = 0) {
    const matches = [...runs].reverse().filter(run => filter === 'pending'
        ? run.suggestions.some(item => item.status === 'pending')
        : filter === 'findings' ? run.suggestions.length > 0 || run.validationIssues?.length > 0 : true);
    const pages = Math.max(1, Math.ceil(matches.length / 20));
    const current = Math.min(Math.max(0, page), pages - 1);
    return { runs: matches.slice(current * 20, current * 20 + 20), page: current, pages, total: matches.length };
}

export function historyStatus(item) {
    if (item.status === 'prepared') return 'Нужно проверить сохранение';
    if (item.status === 'undone') return 'Операция отменена';
    if (item.kind === 'undo') return item.after === null ? 'Запись удалена' : 'Предыдущая версия восстановлена';
    return 'Применено';
}
