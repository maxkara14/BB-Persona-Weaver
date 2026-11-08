import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpaces, originalQuote } from './unicode.mjs';
import { parseResult, validateSuggestions } from './core.mjs';
import { normalizeGeneratedKeys, compileKey, parseKeys } from './keys.mjs';
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

test('new regex separators match all supported blanks and preserve quantifiers, classes and escaped backslashes', () => {
    for (const separator of [' ', '\\s', '\\u2800', '\\u{2800}', '\\x20', '\u2800']) {
        const [key] = normalizeGeneratedKeys([`/blue${separator}+eyes/iu`, '/глаза/iu']);
        for (const code of [32, ...codes]) assert.equal(compileKey(key).test(`blue${String.fromCodePoint(code)}eyes`), true, `${separator}, ${code}`);
        assert.equal(compileKey(key).test('blueeyes'), false);
        assert.equal(compileKey(key).test('blue---eyes'), false);
    }
    const [key] = normalizeGeneratedKeys([String.raw`/a[\s,]{1,3}b/iu`, '/глаза/iu']);
    assert.equal(compileKey(key).test('a\u2800,b'), true);
    assert.equal(compileKey(key).test('ab'), false);
    assert.equal(compileKey(key).test('a    b'), false);
    const [negative] = normalizeGeneratedKeys([String.raw`/a[^\s]b/iu`, '/глаза/iu']);
    assert.equal(compileKey(negative).test('a\u2800b'), false);
    const literal = String.raw`/literal\\s\/path/iu`;
    assert.equal(normalizeGeneratedKeys([literal, '/глаза/iu'])[0], literal);
    assert.equal(parseKeys('/blue\\s+eyes/iu')[0], '/blue\\s+eyes/iu', 'manual parsing must not transform keys');
    const widened = normalizeGeneratedKeys(['/blue\\s+eyes/iu', '/глаза/iu']);
    assert.deepEqual(normalizeGeneratedKeys(widened), widened, 'reused generated keys must not grow');
    const range = String.raw`/[ -~\u2800]/iu`;
    assert.equal(normalizeGeneratedKeys([range, '/глаза/iu'])[0], range, 'literal class ranges must remain intact');
    assert.throws(() => normalizeGeneratedKeys(['/a*/iu', '/глаза/iu']));
});

test('compression cleans prose but preserves entry IDs and rejects blank-only results', () => {
    const id = 'original\u2800id';
    assert.equal(compressionResults({ entries: [{ id, content: 'Новый\u2800текст' }] }, [{ uid: id }]).get(id), 'Новый текст');
    assert.throws(() => compressionResults({ entries: [{ id: 'original id', content: 'Text' }] }, [{ uid: id }]), /ID/);
    assert.throws(() => compressionResults({ entries: [{ id, content: '\u2800\u3164' }] }, [{ uid: id }]), /непустой/);
});
