// ST stores each /pattern/flags literal as one element of entry.key.
export function parseKeys(text) {
    const keys = []; let index = 0;
    while (index < text.length) {
        while (/[\s,]/.test(text[index] || '') && index < text.length) index++;
        if (index === text.length) break;
        const start = index;
        if (text[index] === '/') {
            index++; let closed = false;
            while (index < text.length) {
                if (text[index] === '\\') { index += 2; continue; }
                if (text[index++] === '/') { closed = true; break; }
            }
            if (!closed) throw new Error('Незакрытый regex-ключ.');
            while (/[a-z]/i.test(text[index] || '') && index < text.length) index++;
            const key = text.slice(start, index); compileKey(key); keys.push(key);
            if (index < text.length && !/[\s,]/.test(text[index])) throw new Error('Разделите ключи новой строкой.');
        } else {
            while (index < text.length && !/[,\r\n]/.test(text[index])) index++;
            const key = text.slice(start, index).trim(); if (key) keys.push(key);
        }
    }
    return [...new Set(keys)];
}

export function compileKey(key) {
    const match = key.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (!match || /(^|[^\\])\//.test(match[1])) throw new Error('Невалидный regex-ключ SillyTavern.');
    try { return new RegExp(match[1].replace('\\/', '/'), match[2]); }
    catch { throw new Error('Ошибка синтаксиса regex-ключа.'); }
}

export function validateGeneratedKeys(keys) {
    if (!Array.isArray(keys) || keys.length !== 2) throw new Error('Нужны два regex-ключа: RU и EN. Повторите анализ.');
    for (const key of keys) {
        if (typeof key !== 'string' || key.length > 3000) throw new Error('Некорректная длина regex-ключа.');
        const regex = compileKey(key);
        if (!regex.unicode || !regex.ignoreCase || regex.global || regex.sticky || regex.test('')) throw new Error('Regex-ключ должен иметь флаги iu, без g/y, и не совпадать с пустой строкой.');
    }
}
