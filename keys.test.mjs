import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, compileKey, validateGeneratedKeys } from './keys.mjs';
import { defaultPrompt, analysisPrompt } from './prompt.mjs';

const ru = String.raw`/(?:^|[^\p{L}\p{N}_])(?:дит[яё]\s+солнц\p{L}*|свет\s+прид[её]т)(?=$|[^\p{L}\p{N}_])/iu`;
const en = String.raw`/(?:^|[^\p{L}\p{N}_])(?:child\s+of\s+the\s+sun|light\s+will\s+come)(?=$|[^\p{L}\p{N}_])/iu`;
test('RU/EN literals match phrases and punctuation but not embedded words', () => {
    validateGeneratedKeys([ru, en]);
    assert.equal(compileKey(ru).test('«Дитя солнца»'), true);
    assert.equal(compileKey(ru).test('СВЕТ ПРИДЁТ!'), true);
    assert.equal(compileKey(en).test('The child of the sun.'), true);
    assert.equal(compileKey(ru).test('поддитя солнца'), false);
    assert.equal(compileKey(en).test('child of the sunny'), false);
});
test('comma quantifiers stay inside one key; newline and legacy commas both work', () => {
    const quantified = String.raw`/рана\s{1,3}руки/iu`;
    assert.deepEqual(parseKeys(`${quantified}, ${en}`), [quantified, en]);
    assert.deepEqual(parseKeys([ru, en].join('\n')), [ru, en]);
    assert.deepEqual(parseKeys('шов, рана'), ['шов', 'рана']);
    assert.deepEqual(parseKeys(String.raw`/a\/b/iu`), [String.raw`/a\/b/iu`]);
});
test('invalid, missing, global or empty-matching generated regex keys are rejected', () => {
    for (const pair of [[], ['plain', en], ['/[/iu', en], ['/a/giu', en], ['/a*/iu', en], ['/a/i', en]]) assert.throws(() => validateGeneratedKeys(pair));
    assert.throws(() => parseKeys('/unclosed'));
});
test('default instructions are English, persona-language output and bilingual regex are explicit', () => {
    assert.ok(defaultPrompt().startsWith('You edit'));
    const prompt = analysisPrompt({ personaName: 'Aya', description: 'Ая — русское описание.' }, [], []);
    assert.ok(prompt[0].content.includes('PERSONA DESCRIPTION'));
    assert.ok(prompt[0].content.includes('Russian regex followed by an English regex'));
    const custom = analysisPrompt({ personaName: '', description: '' }, [], [], 'Custom rules');
    assert.ok(custom[0].content.startsWith('Custom rules'));
    assert.ok(custom[0].content.includes('Entry content follows the persona description language'));
    for (const system of [prompt[0].content, custom[0].content]) {
        assert.equal(system.split('Mandatory fact-selection rules:').length - 1, 1, 'Default and custom paths must each include the mandatory selection policy once');
        assert.ok(system.includes('BOTH the persona description and existing entries'));
        assert.ok(system.includes('ONE explicit episode'));
        assert.ok(system.includes('Never manufacture a finding'));
        assert.equal(system.split('Mandatory section structure:').length - 1, 1);
        assert.ok(system.includes('ONLY sourceId'));
        assert.ok(system.includes('do not invent or renumber IDs'));
        assert.ok(system.includes('retrieves the original paragraph text and author automatically'));
    }
    const data = JSON.parse(prompt[1].content);
    assert.equal(data.sections.length, 6);
    assert.equal(data.sections.find(section => section.category === 'relationships').title, 'Отношения Aya');
    assert.ok(data.sections.every(section => section.target === null));
});
