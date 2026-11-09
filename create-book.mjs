export function personaBookName(personaName) {
    const label = String(personaName ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().replace(/[. ]+$/, '').slice(0, 60).replace(/[. ]+$/, '') || 'Персона';
    return 'Persona Weaver — ' + label;
}

export function validateBookName(value) {
    const name = String(value ?? '').trim();
    if (!name || name.length > 120 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /\.$/.test(name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw new Error('Введите название до 120 символов без символов <>:"/\\|?* и точки в конце.');
    }
    return name;
}

export async function createAndBindBook(name, adapter, { automatic = false } = {}) {
    name = validateBookName(name);
    const books = await adapter.list();
    const normalized = value => value.normalize('NFC').toLowerCase();
    if (automatic) {
        const base = name; let suffix = 2;
        while (books.some(book => normalized(book) === normalized(name))) name = `${base} (${suffix++})`;
    }
    if (books.some(book => normalized(book) === normalized(name))) {
        throw new Error('Лорбук с таким названием уже существует. Выберите другое название или привяжите существующий.');
    }
    adapter.assertCurrent();
    await adapter.write(name, { entries: {} });
    adapter.assertCurrent();
    await adapter.bind(name);
    return name;
}
