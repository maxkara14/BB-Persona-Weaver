import { normalizeSpaces, SPACE_SUBSTITUTES } from './unicode.mjs';

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

export function normalizeGeneratedKeys(keys) {
    validateGeneratedKeys(keys);
    const normalized = keys.map(key => {
        const end = key.lastIndexOf('/');
        const body = key.slice(1, end);
        let result = '', inClass = false;
        const separator = () => inClass ? ` ${SPACE_SUBSTITUTES}` : `[\\s${SPACE_SUBSTITUTES}]`;
        for (let i = 0; i < body.length; i++) {
            const char = body[i];
            // Do not expand an already widened class again when the model reuses it.
            const widened = `\\s${SPACE_SUBSTITUTES}`;
            if (inClass && body.startsWith(widened, i)) {
                result += widened; i += widened.length - 1; continue;
            }
            if (char === '\\') {
                if (body[i + 1] === 's') {
                    result += inClass ? `\\s${SPACE_SUBSTITUTES}` : separator();
                    i++;
                } else {
                    const literal = body.slice(i).match(/^\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/i);
                    const code = literal && Number.parseInt(literal[1] ?? literal[2] ?? literal[3], 16);
                    if (!inClass && literal && code <= 0x10FFFF && normalizeSpaces(String.fromCodePoint(code)) === ' ') {
                        result += separator(); i += literal[0].length - 1;
                    } else { result += char + body[++i]; }
                }
            } else if (char === '[') { inClass = true; result += char; }
            else if (char === ']') { inClass = false; result += char; }
            // Literal characters in classes may be endpoints of ranges: leave them intact.
            else if (!inClass && normalizeSpaces(char) === ' ') result += separator();
            else result += char;
        }
        return `/${result}/${key.slice(end + 1)}`;
    });
    validateGeneratedKeys(normalized);
    return normalized;
}
