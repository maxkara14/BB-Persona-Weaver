// Approved structure: one managed entry per persona/category; existing text is
// supplied for a complete reviewed replacement. Never merge/delete books here.
import { normalizeSpaces } from './unicode.mjs';

export const SECTION_NAMES = Object.freeze({
    appearance: 'Внешность', habits: 'Привычки', skills: 'Навыки',
    history: 'Биография', values: 'Ценности', relationships: 'Отношения',
});

export function entryOrder(settings = {}, number = 1) {
    const clamp = (value, fallback) => Number.isFinite(Number(value)) ? Math.min(9999, Math.max(0, Math.trunc(Number(value)))) : fallback;
    const index = Math.max(1, Math.trunc(Number(number)) || 1);
    if (settings.mode === 'auto') return clamp(index, 1);
    if (settings.mode === 'reverse') return clamp(clamp(settings.reverseStart, 9999) - (index - 1), 0);
    return clamp(settings.value ?? 100, 100);
}

export function categoryKey(name) { return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase().replace(/ё/g, 'е'); }

export function customCategory(name) {
    if (typeof name === 'string') name = normalizeSpaces(name);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /[\r\n\p{Cc}]/u.test(name)) throw new Error('Название категории должно содержать от 1 до 60 символов в одной строке.');
    const clean = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const key = categoryKey(clean);
    const reserved = [...Object.keys(SECTION_NAMES), ...Object.values(SECTION_NAMES), 'Привычки и предпочтения', 'Навыки и ограничения', 'Прошлое и семья', 'Ценности и границы'];
    if (reserved.some(label => categoryKey(label) === key)) throw new Error('Такая стандартная категория уже есть. Выберите существующий раздел.');
    return { category: `custom:${key}`, categoryName: clean };
}

export function sectionTitle(category, personaName, categoryName) {
    const name = Object.hasOwn(SECTION_NAMES, category) ? SECTION_NAMES[category] : categoryName;
    if (!name) throw new Error('Неизвестный раздел персоны.');
    return normalizeSpaces(`${name} ${personaName}`);
}

export function sectionEntries(entries) {
    const sections = new Map();
    for (const entry of entries) {
        const category = entry.personaCanon?.category;
        if (!Object.hasOwn(SECTION_NAMES, category) && !(typeof category === 'string' && category.startsWith('custom:') && entry.personaCanon.categoryName)) continue;
        if (sections.has(category)) throw new Error(`В разделе «${SECTION_NAMES[category] ?? entry.personaCanon.categoryName}» несколько старых записей. Сначала согласуйте их объединение; расширение не удаляет и не объединяет их автоматически.`);
        sections.set(category, entry);
    }
    return sections;
}

export function sectionSuggestions(suggestions, entries, personaName) {
    const sections = sectionEntries(entries);
    const used = new Set();
    return suggestions.map(original => {
        let suggestion = original;
        if (original.category === 'custom') {
            const custom = customCategory(original.categoryName);
            if (typeof original.categoryReason !== 'string' || !original.categoryReason.trim() || original.categoryReason.length > 1000) throw new Error('Для новой категории нужно объяснение, почему существующие разделы не подходят.');
            if (sections.has(custom.category)) throw new Error('Предложенная категория уже существует. Нужно обновить существующий раздел.');
            suggestion = { ...original, ...custom, requiresCategoryApproval: true,
                categoryProposal: { name: custom.categoryName, reason: original.categoryReason, content: original.content, keywords: original.keywords } };
        }
        if (used.has(suggestion.category)) throw new Error(`Для раздела «${SECTION_NAMES[suggestion.category] ?? suggestion.categoryName ?? sections.get(suggestion.category)?.personaCanon.categoryName}» нужен один общий обновлённый текст, а не несколько отдельных записей. Повторите анализ.`);
        used.add(suggestion.category);
        const existing = sections.get(suggestion.category);
        const target = existing ? String(existing.uid) : null;
        if (suggestion.target !== target) throw new Error(`Раздел «${sectionTitle(suggestion.category, personaName, existing?.personaCanon.categoryName ?? suggestion.categoryName)}» требует ${existing ? 'обновления существующей записи целиком' : 'создания новой записи'}. Модель указала неверную цель. Повторите анализ.`);
        const categoryName = existing?.personaCanon.categoryName ?? suggestion.categoryName;
        return { ...suggestion, categoryName, title: sectionTitle(suggestion.category, personaName, categoryName) };
    });
}

export function assertSectionTarget(entries, suggestion) {
    const current = sectionEntries(entries).get(suggestion.category);
    if ((current ? String(current.uid) : null) !== suggestion.target) {
        throw new Error('Раздел уже создан, удалён или заменён после анализа. Повторите анализ, чтобы обновить актуальную запись.');
    }
}
