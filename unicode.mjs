// Approved scope: normalize display prose and JSON syntax, preserve original
// evidence/IDs, and extend only newly generated regex whitespace separators.
export const SPACE_SUBSTITUTES = String.raw`\u00A0\u1680\u2000-\u200B\u202F\u205F\u2800\u3000\uFEFF\u115F\u1160\u3164\uFFA0`;
const spaces = new RegExp(`[${SPACE_SUBSTITUTES}]`, 'g');

export function normalizeSpaces(value) {
    return String(value ?? '').replace(spaces, ' ');
}

export function normalizeJsonSyntax(text) {
    let quoted = false, escaped = false, result = '';
    for (const char of text) {
        if (quoted) {
            result += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else {
            if (char === '"') quoted = true;
            result += normalizeSpaces(char);
        }
    }
    return result;
}

export function originalQuote(source, quote) {
    const exact = source.indexOf(quote);
    if (exact >= 0) return source.slice(exact, exact + quote.length);
    // Each replacement is one UTF-16 code unit, so offsets still address source.
    const index = normalizeSpaces(source).indexOf(normalizeSpaces(quote));
    return index < 0 ? null : source.slice(index, index + quote.length);
}
