import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpaces, originalQuote } from './unicode.mjs';
import { parseResult, validateSuggestions } from './core.mjs';
import { validateGeneratedKeys, compileKey, parseKeys } from './keys.mjs';
import { compressionResults } from './compression.mjs';

const codes = [0xA0, 0x1680, ...Array.from({ length: 12 }, (_, i) => 0x2000 + i),
    0x202F, 0x205F, 0x2800, 0x3000, 0xFEFF, 0x115F, 0x1160, 0x3164, 0xFFA0];

test('prose normalization replaces only supported spaces, preserving layout and writing systems', () => {
    for (const code of codes) assert.equal(normalizeSpaces(`a${String.fromCodePoint(code)}b`), 'a b');
    const text = 'Русский  text\r\n\t👩‍💻 ❤️ فارسی\u200Ctext\u2060\u180E';
    assert.equal(normalizeSpaces(text), text);
    assert.equal(normalizeSpaces('a\u2800\u2800b'), 'a  b');
});

test('JSON syntax cleanup preserves every string value including IDs, escapes, regex and source quotes', () => {
    const expected = { id: 'id\u2800original', quote: '👩‍💻\u2800слово "цитата" \\ конец', regex: '/a\\s+b/iu', escaped: '\u2800' };
    const valid = JSON.stringify(expected);
    // Alter syntax only; string contents must remain identical, including escaped U+2800.
    for (const code of codes) {
        const raw = '{' + String.fromCodePoint(code) + valid.slice(1, -1) + String.fromCodePoint(code) + '}';
        assert.deepEqual(parseResult('```json\n' + raw + '\n```'), expected);
    }
    assert.throws(() => parseResult('{"x": [broken]}'), /невалидный JSON/);
});

test('legacy evidence tolerates only space substitutes and retrieves the original contiguous quote', () => {
    const text = '👩‍💻 Мои\u2800голубые\u3164глаза.';
    assert.equal(originalQuote(text, 'Мои голубые глаза'), 'Мои\u2800голубые\u3164глаза');
    for (const bad of ['Мои  голубые глаза', 'Мои голубые\nглаза', 'Мои...глаза', 'мои голубые глаза']) assert.equal(originalQuote(text, bad), null);
    const sources = [{ id: 0, text, author: 'user' }];
    const raw = { target: null, category: 'appearance', title: 'Цвет\u2800глаз', content: 'Голубые\u2800глаза.', reason: 'Из\u2800сцены.', conflict: false,
        evidence: [{ messageId: 0, quote: 'Мои голубые глаза' }] };
    const [result] = validateSuggestions({ suggestions: [raw] }, { sources });
    assert.equal(result.title, 'Цвет глаз'); assert.equal(result.content, 'Голубые глаза.'); assert.equal(result.reason, 'Из сцены.');
    assert.equal(result.evidence[0].quote, 'Мои\u2800голубые\u3164глаза');
    raw.evidence = [{ sourceId: '0:1' }];
    assert.equal(validateSuggestions({ suggestions: [raw] }, { sources })[0].evidence[0].quote, text);
    raw.evidence = [{ sourceId: '0:\u28001' }];
    assert.throws(() => validateSuggestions({ suggestions: [raw] }, { sources }), /ID абзаца/);
    raw.evidence = [{ messageId: 0, quote: '\u2800' }];
    assert.throws(() => validateSuggestions({ suggestions: [raw] }, { sources }), /цитата/);
    raw.content = '\u2800\u3164';
    assert.throws(() => validateSuggestions({ suggestions: [raw] }, { sources }), /содержание/);
});

test('ordinary compact keys stay valid without decorative Unicode separators', () => {
    const keys = [String.raw`/отношения\s+с\s+Сирацую/iu`, '/Shiratsuyu/iu'];
    const before = structuredClone(keys);
    validateGeneratedKeys(keys);
    assert.deepEqual(keys, before);
    assert.deepEqual(parseKeys(keys.join('\n')), keys);
    assert.equal(compileKey(keys[0]).test('отношения с Сирацую'), true);
    assert.equal(compileKey(keys[1]).test('⠀Shiratsuyu⠀'), true);
    const long = ['/a' + Array(36).fill(String.raw`\s+b`).join('') + '/iu', '/name/iu'];
    validateGeneratedKeys(long);
    assert.equal(long[0].length, 149);
    assert.throws(() => validateGeneratedKeys(['/a*/iu', '/name/iu']));
});

test('compression cleans prose but preserves entry IDs and rejects blank-only results', () => {
    const id = 'original\u2800id';
    assert.equal(compressionResults({ entries: [{ id, content: 'Новый\u2800текст' }] }, [{ uid: id }]).get(id), 'Новый текст');
    assert.throws(() => compressionResults({ entries: [{ id: 'original id', content: 'Text' }] }, [{ uid: id }]), /ID/);
    assert.throws(() => compressionResults({ entries: [{ id, content: '\u2800\u3164' }] }, [{ uid: id }]), /непустой/);
});
