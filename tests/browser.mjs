/** Isolated browser fixture: runs the real extension entrypoint and UI;
 * all upstream ST modules and APIs are simulated. No user chat/book is accessed.
 * Uses an existing Playwright installation; does not add a runtime dependency.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { firefox } = await import(process.env.PERSONA_CANON_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const hasOverflow = node => [node, ...node.querySelectorAll('.pc-body,.pc-panel,.pc-settings-screen')]
    .some(surface => surface.getClientRects().length && surface.scrollWidth > surface.clientWidth + 1);
const bookNames = new Set(['Канон']);
let book = { entries: {} }, bookExists = true, readDelay = 0, writes = 0, customCalls = 0;
const answer = { suggestions: [{ target: null, category: 'skills', title: 'Навыки',
    content: 'Умеет зашивать раны.', keywords: ['/раны/iu', '/wounds/iu'], reason: 'Прямое утверждение. <img src=x onerror=alert(1)>', conflict: false,
    evidence: [{ messageId: 0, quote: 'Мать научила меня зашивать раны.' }] }] };
const modules = {
    '/scripts/extensions.js': 'export const getContext = () => window.fixture.ctx;',
    '/script.js': 'export const eventSource=window.fixture.events; export const event_types=window.fixture.types; export const isGenerating=()=>false; export const saveSettingsDebounced=()=>localStorage.setItem("fixtureSettings",JSON.stringify(window.fixture.ctx.extensionSettings));',
    '/scripts/personas.js': 'export let user_avatar="aya.png"; export const getOrCreatePersonaDescriptor=()=>window.fixture.power.persona_descriptions[user_avatar]; export function setPersonaDescription(){}',
    '/scripts/power-user.js': 'export const power_user=window.fixture.power;',
    '/scripts/user.js': 'export const getCurrentUserHandle=()=>"fixture-account";',
    '/scripts/openai.js': 'export const getChatCompletionModel=()=>"fixture-current";',
    '/scripts/textgen-settings.js': 'export const getTextGenModel=()=>"fixture-text-current";',
    '/scripts/extensions/shared.js': 'export class ConnectionManagerRequestService { static getSupportedProfiles(){return window.fixture.profiles} static constructPrompt(messages,id){return id==="text"?JSON.stringify(messages):messages} static async sendRequest(id,prompt,max,options){ if(id==="text"&&typeof prompt!=="string")throw Error("bad text prompt"); window.fixture.profileCalls++; return {content:JSON.stringify(window.fixture.answer)}; }}',
    '/scripts/world-info.js': 'export const world_names=["Канон"]; export const worldInfoCache=new Map(); export const updateWorldInfoList=async()=>{}; export const reloadEditor=()=>{}; export function createWorldInfoEntry(name,data){const uid=Math.max(-1,...Object.keys(data.entries).map(Number))+1; return data.entries[uid]={uid,key:[],keysecondary:[],content:"",comment:"",constant:false,disable:false,order:100,position:0,probability:100};}',
};
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
body{margin:0;background:#181a1d;color:#eeeae2;font:16px/1.5 "Segoe UI",sans-serif;--SmartThemeBlurTintColor:#202225;--SmartThemeBodyColor:#eeeae2;--SmartThemeBorderColor:#484a4b;--SmartThemeQuoteColor:#d4b17c;}button{font:inherit}.pc-fixture-hidden{display:none}
</style><link rel="stylesheet" href="/scripts/extensions/third-party/Persona-Canon/style.css"></head><body><div id="extensions_settings2"></div><div id="extensionsMenu"></div><button id="extensionsMenuButton">Меню</button><div id="chat"><div class="mes" mesid="0">Мать научила меня зашивать раны.</div></div><script>
const listeners=new Map();
window.fixture={calls:0,profileCalls:0,answer:${JSON.stringify(answer)},profiles:[{id:'text',name:'Текстовый профиль',model:'fixture-text'}],
types:{CHAT_CHANGED:'chat_changed',PERSONA_CHANGED:'persona_changed',APP_READY:'ready',GENERATION_STOPPED:'stopped',WORLDINFO_UPDATED:'world_updated',MESSAGE_RECEIVED:'message_received',GENERATION_ENDED:'generation_ended'},
events:{on(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn)},async emit(type,...args){for(const fn of listeners.get(type)||[])await fn(...args)},removeListener(){}},
power:{persona_description_lorebook:'Канон',persona_description:'Краткое ядро.',reasoning:{},persona_descriptions:{'aya.png':{lorebook:'Канон'}}},
ctx:{chat:[{mes:'Мать научила меня зашивать раны.',is_user:true,name:'Ая'},{mes:'Она взяла иглу.',name:'Рассказчик',swipe_id:0}],chatMetadata:{integrity:'fixture-a'},characters:[{avatar:'npc.png'}],characterId:0,groupId:null,name1:'Ая',mainApi:'openai',onlineStatus:'connected',maxContext:32000,
extensionSettings:JSON.parse(localStorage.getItem('fixtureSettings')||'{}'),getCurrentChatId:()=> 'Дорога на север', getRequestHeaders:()=>({'Content-Type':'application/json'}),getTokenCountAsync:async()=>550,extractMessageFromData:data=>data.choices[0].message.content,
async generateRawData(params){window.fixture.lastPrompt=params.prompt;window.fixture.calls++;return {choices:[{message:{content:JSON.stringify(window.fixture.answer)}}]};}}};
fixture.ctx.powerUserSettings=fixture.power;window.jQuery=fn=>fn();
fixture.notices=[];window.toastr=Object.fromEntries(['info','success','error'].map(level=>[level,(message,title,options)=>fixture.notices.push({level,message,title,options})]));
</script><script type="module" src="/scripts/extensions/third-party/Persona-Canon/index.js"></script></body></html>`;

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        let type = 'application/javascript', content;
        if (path === '/') { type = 'text/html'; content = html; }
        else if (modules[path]) content = modules[path];
        else if (path.startsWith('/scripts/extensions/third-party/Persona-Canon/') && /^[\w.-]+$/.test(path.split('/').at(-1))) {
            const file = path.split('/').at(-1); type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
            content = await readFile(join(root, file));
        } else if (path === '/api/worldinfo/list') {
            type = 'application/json'; content = JSON.stringify(bookExists ? [...bookNames].map(file_id => ({file_id})) : []);
        } else if (path === '/api/worldinfo/get' || path === '/api/worldinfo/edit') {
            let text = ''; for await (const chunk of req) text += chunk;
            const data = JSON.parse(text);
            assert.ok(data.name === 'Канон' || data.name.startsWith('Persona Weaver ')); if(path.endsWith('/edit')) bookNames.add(data.name);
            type = 'application/json';
            if (path.endsWith('/edit')) { book = data.data; writes++; content = '{"ok":true}'; }
            else { if(readDelay) await new Promise(resolve => setTimeout(resolve,readDelay)); content = JSON.stringify(book); }
        } else { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': type }); res.end(content);
    } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await firefox.launch({ headless: true, ...(process.env.PERSONA_CANON_FIREFOX ? { executablePath: process.env.PERSONA_CANON_FIREFOX } : {}) });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('https://fixture-api.test/**', async route => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (request.url().endsWith('/models')) return route.fulfill({ headers, body: JSON.stringify({ data: [{ id: 'fixture-custom' }, { id: 'other-model' }] }) });
        customCalls++;
        const payload = JSON.parse(request.postData()); assert.equal(payload.model, 'fixture-custom');
        return route.fulfill({ headers, body: JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.display_name, 'BB Persona Weaver');
    assert.equal(await page.locator('#extensions_settings2').evaluate(node => node.childElementCount), 0, 'No large settings panel');
    const wand = page.getByRole('button', { name: 'Persona Weaver', exact: true });
    assert.equal(await wand.evaluate(node => node.tagName), 'DIV', 'Use the native wand row instead of a form button');
    assert.equal(await wand.locator('.extensionsMenuExtensionButton.fa-feather-pointed').count(), 1);
    let stIcons;
    try { stIcons = await readFile(join(root, '../../../../css/fontawesome.min.css'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stIcons) assert.ok(stIcons.includes('.fa-feather-pointed:before'), 'Wand icon must exist in the installed ST icon set');
    await page.evaluate(() => fixture.events.emit('ready'));
    assert.equal(await page.locator('#persona-canon-menu').count(), 1, 'Repeated registration must not duplicate the entry');
    await wand.focus(); await wand.press('Enter');
    await page.locator('#persona-canon-dialog').waitFor();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await wand.focus(); await wand.press('Space');
    await page.locator('#persona-canon-dialog').waitFor();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    const screenshotDir = process.env.PERSONA_CANON_SCREENSHOTS;
    assert.ok((await page.locator('#persona-canon-dialog').boundingBox()).width <= 680, 'Compact desktop width');
    assert.equal(await page.locator('.pc-provider-form').count(), 0, 'Connection form must not inflate the analysis screen');
    assert.equal(await page.getByText('Единственный лорбук персоны', { exact: true }).count(), 0);
    const range = page.locator('.pc-range-row');
    const runButton = await range.getByRole('button', { name: 'Анализировать', exact: true }).boundingBox();
    for (const box of await range.locator('input').all()) {
        const rect = await box.boundingBox(); assert.ok(Math.abs(rect.y + rect.height - runButton.y - runButton.height) <= 1, 'Range/action bottoms align');
    }
    if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-canon-compact-main.png') }); }
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.getByText('Найдено предложений: 1.', { exact: false }).waitFor();
    assert.equal(writes, 0);
    assert.equal(await page.locator('#persona-canon-dialog img').count(), 0, 'Model text must not become HTML');
    await page.getByLabel('Предлагаемый текст', { exact: true }).fill('Правка пользователя сохранена.');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    assert.equal(await page.getByLabel('Предлагаемый текст', { exact: true }).inputValue(), 'Правка пользователя сохранена.');
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.getByText('Откройте прежние находки', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => fixture.calls), 0, 'Repeated scene must not request generation after reload');

    if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, 'persona-canon-live-desktop.png') }); }
    for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1100 });
        assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, `dialog overflow at ${width}`);
    }
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.locator('.pc-item').first().click();
    await page.getByLabel('Предлагаемый текст', { exact: true }).waitFor({ state: 'visible' });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'persona-canon-live-mobile.png') });
    await page.getByRole('button', { name: 'Принять и сохранить', exact: true }).click();
    await page.getByText('Правка сохранена в лорбук.', { exact: true }).waitFor();
    assert.equal(writes, 1); assert.equal(book.entries[0].content, 'Правка пользователя сохранена.');
    assert.equal(book.entries[0].comment, 'Навыки Ая', 'Saved entry title is the section plus persona, not a model-selected topic');
    assert.equal(book.entries[0].disable, false); assert.equal(book.entries[0].personaCanon.origins[0].kind, 'chat');
    await page.setViewportSize({ width: 1440, height: 1100 });
    readDelay = 200;
    const beforeEntries = await page.locator('#persona-canon-dialog').boundingBox();
    await page.getByRole('tab', { name: 'Записи', exact: true }).click();
    assert.equal(await page.locator('.pc-review').count(), 1, 'Old screen stays visible while entries load');
    await page.locator('.pc-record').first().waitFor();
    const afterEntries = await page.locator('#persona-canon-dialog').boundingBox();
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(afterEntries[key]-beforeEntries[key])<1, 'Entries window geometry: '+key);
    readDelay = 0;
    await page.locator('.pc-record').first().waitFor();
    await page.getByText('Метки отдельных добавлений', { exact: true }).click();
    await page.locator('.pc-record select').selectOption('general');
    await page.getByText('Метка обновлена.', { exact: false }).waitFor();
    assert.equal(book.entries[0].personaCanon.origins[0].kind, 'general');
    await page.getByRole('tab', { name: 'История', exact: true }).click();
    await page.getByRole('button', { name: 'Восстановить предыдущую версию', exact: true }).first().click();
    await page.getByText('Операция отменена.', { exact: true }).waitFor();
    await page.getByText('Предыдущая версия восстановлена', { exact: false }).waitFor();
    assert.equal(book.entries[0].personaCanon.origins[0].kind, 'chat');
    await page.getByRole('button', { name: 'Удалить созданную запись', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#persona-canon-dialog[aria-busy]'));
    await page.getByText('Запись удалена', { exact: false }).waitFor();
    assert.equal(Object.keys(book.entries).length, 0);

    await page.getByLabel('До', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const stableWindow = await page.locator('#persona-canon-dialog').boundingBox();
    await page.getByLabel('Тип подключения', { exact: true }).selectOption('custom');
    assert.equal(await page.locator('.pc-scene').count(), 0, 'Settings have a separate screen');
    assert.equal(await page.getByLabel('Тайм-аут, с', { exact: true }).isVisible(), false, 'Advanced limits are collapsed');
    await page.getByLabel('URL API', { exact: true }).fill('https://fixture-api.test/v1');
    const customWindow = await page.locator('#persona-canon-dialog').boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(customWindow[key] - stableWindow[key]) < 1, `Window jumps: ${key}`);
    await page.getByLabel('API-ключ', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: 'Загрузить модели', exact: true }).click();
    await page.getByLabel('Доступные модели', { exact: true }).selectOption('fixture-custom');
    if (screenshotDir) await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-canon-compact-settings.png') });
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    assert.equal(await page.getByLabel('До', { exact: true }).inputValue(), '0', 'Range survives settings navigation');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await page.getByText('Новых устойчивых деталей нет.', { exact: false }).first().waitFor();
    assert.equal(customCalls, 1);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByLabel('Тип подключения', { exact: true }).selectOption('profile');
    await page.getByLabel('Connection Manager', { exact: true }).selectOption('text');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await page.waitForFunction(() => fixture.profileCalls === 1 && !document.querySelector('#persona-canon-dialog[aria-busy]'));
    assert.equal(await page.evaluate(() => fixture.ctx.mainApi), 'openai');
    assert.equal(await page.evaluate(() => JSON.stringify(fixture.ctx.extensionSettings).includes('fixture-secret')), false);
    await page.reload();
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByLabel('Тип подключения', { exact: true }).selectOption('custom');
    assert.equal(await page.getByLabel('API-ключ', { exact: true }).inputValue(), '');
    for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, `settings overflow at ${width}`);
    }
    await page.getByText('Дополнительно', { exact: true }).click();
    assert.equal(await page.getByLabel('Тайм-аут, с', { exact: true }).isVisible(), true);
    await page.getByLabel('Контекст, токены', { exact: true }).fill('32000');
    await page.getByText('Лорбук персоны', { exact: true }).first().click();
    assert.equal(await page.getByLabel('Лорбук персоны', { exact: true }).inputValue(), 'Канон');
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Expanded settings fit at 320px');
    await page.getByLabel('Тип подключения', { exact: true }).selectOption('current');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByRole('tab', { name: 'Сцены', exact: true }).click();
    const successfulRuns = await page.locator('.pc-record').count();
    await page.evaluate(() => {
        fixture.ctx.generateRawData = () => {
            fixture.pendingRaw = true;
            return new Promise((resolve, reject) => fixture.events.on('stopped', () => reject(new Error('cancelled'))));
        };
    });
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await page.getByRole('button', { name: 'Отменить запрос', exact: true }).waitFor();
    await page.waitForFunction(() => fixture.pendingRaw === true);
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Busy header fits at 320px');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.locator('.pc-activity').getByText('Ожидание ответа модели…', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Анализировать', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Отменить запрос', exact: true }).click();
    await page.getByText('Анализ отменён.', { exact: true }).waitFor();
    assert.equal(await page.locator('.pc-record').count(), successfulRuns, 'Cancelled request does not cover a new scene');
    bookExists = false;
    const previousWrites = writes;
    await page.getByRole('tab', { name: 'Записи', exact: true }).click();
    await page.getByText('Лорбук не найден.', { exact: false }).waitFor();
    assert.equal(writes, previousWrites, 'Missing books must not be recreated');
    const touch = await browser.newPage({ viewport: { width: 320, height: 844 }, hasTouch: true });
    touch.on('pageerror', error => errors.push(error.message));
    bookExists = true;
    await touch.goto(`http://127.0.0.1:${server.address().port}`);
    await touch.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    assert.equal(await touch.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Touch analysis fits');
    await touch.getByRole('button', { name: 'Настройки', exact: true }).click();
    await touch.getByLabel('Тип подключения', { exact: true }).selectOption('custom');
    await touch.getByText('Дополнительно', { exact: true }).click();
    assert.equal(await touch.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Touch settings fit');
    assert.ok((await touch.getByRole('button', { name: 'Загрузить модели', exact: true }).boundingBox()).height >= 44);
    await touch.evaluate(async () => { fixture.ctx.chatMetadata.integrity = ''; await fixture.events.emit('chat_changed'); });
    await touch.getByLabel('Тип подключения', { exact: true }).selectOption('profile');
    await touch.getByLabel('Connection Manager', { exact: true }).waitFor();
    await touch.getByRole('button', { name: 'Готово', exact: true }).click();
    await touch.getByText('Откройте чат и выберите персону', { exact: true }).waitFor();
    await touch.getByRole('button', { name: 'Настройки подключения', exact: true }).click();
    await touch.getByLabel('Connection Manager', { exact: true }).waitFor();
    await touch.close();
    await page.reload();
    await page.evaluate(() => { fixture.ctx.chatMetadata.integrity = 'auto-browser'; fixture.power.persona_description_lorebook = ''; fixture.power.persona_descriptions['aya.png'].lorebook = ''; });
    const beforeAutomaticWrites = writes;
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByText('Параметры записей', { exact: true }).click();
    assert.equal(await page.getByLabel('Приоритет новых записей', { exact: true }).inputValue(), 'manual');
    await page.getByLabel('Приоритет новых записей', { exact: true }).selectOption('reverse');
    await page.getByLabel('Начальное значение приоритета', { exact: true }).fill('30');
    await page.getByLabel('Приоритет новых записей', { exact: true }).selectOption('auto');
    await page.getByLabel('Приоритет новых записей', { exact: true }).selectOption('manual');
    await page.getByLabel('Приоритет', { exact: true }).fill('321');
    assert.equal(await page.getByLabel('Сохранять значимые события персоны', { exact: true }).isChecked(), false);
    await page.getByLabel('Сохранять значимые события персоны', { exact: true }).check();
    await page.getByLabel('Векторизация', { exact: true }).check();
    await page.getByText('Промпт сборки и ключей', { exact: true }).click();
    await page.getByLabel('Инструкции модели', { exact: true }).fill('Пиши кратко. Подбирай точные ключи.');
    await page.getByText('Автосоздание записей', { exact: true }).click();
    await page.getByLabel('Автоматический анализ этого чата', { exact: true }).check();
    await page.getByLabel('Интервал сообщений', { exact: true }).fill('1');
    await page.getByLabel('Автоматически сохранять проверенные находки', { exact: true }).check();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.evaluate(() => {
        const original = fixture.ctx.generateRawData;
        fixture.ctx.generateRawData = async params => {
            const result = await original(params);
            return new Promise((resolve, reject) => {
                fixture.resolveAnalysis = () => resolve(result);
                fixture.events.on('stopped', () => { fixture.wasCancelled = true; reject(new Error('cancelled')); });
            });
        };
    });
    await page.evaluate(() => fixture.events.emit('message_received'));
    await page.waitForFunction(() => fixture.calls === 1 && fixture.resolveAnalysis);
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.locator('.pc-activity').getByText('Автоанализ', { exact: false }).waitFor();
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Automatic activity fits at 320px');
    if (screenshotDir) {
        await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-weaver-auto-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-weaver-auto-desktop.png') });
        await page.setViewportSize({ width: 320, height: 844 });
    }
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.equal(await page.evaluate(() => Boolean(fixture.wasCancelled)), false, 'Closing the window must not cancel automatic analysis');
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.locator('.pc-activity').getByText('Ожидание ответа модели…', { exact: false }).waitFor();
    await page.evaluate(() => fixture.resolveAnalysis());
    await page.waitForFunction(() => fixture.notices.some(notice => notice.level === 'success'));
    assert.equal(await page.locator('.pc-activity').isVisible(), false, 'Completed analysis clears the activity indicator');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByText('Сохранено', { exact: true }).waitFor();
    assert.equal(writes, beforeAutomaticWrites + 2, 'Automation creates the book once, then writes the entry');
    assert.ok(await page.evaluate(() => fixture.power.persona_description_lorebook.startsWith('Persona Weaver ')));
    assert.equal(book.entries[0].vectorized, true);
    assert.equal(book.entries[0].order, 321);
    assert.ok(await page.evaluate(() => JSON.stringify(fixture.lastPrompt).includes('Пиши кратко')));
    assert.ok(await page.evaluate(() => fixture.lastPrompt[0].content.includes('SAVE SIGNIFICANT PERSONAL EVENTS')));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('fixtureSettings'))['Persona-Canon'].saveEvents), true);
    const notifications = await page.evaluate(() => fixture.notices);
    assert.deepEqual(notifications.map(notice => notice.level), ['info', 'success']);
    assert.ok(notifications[0].message.includes('Начат автоматический анализ'));
    assert.ok(notifications[1].message.includes('Сохранено записей: 1'));
    assert.ok(notifications[1].message.includes('Ожидают проверки: 0'));
    assert.equal(notifications[1].options.escapeHtml, true);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByText('Лорбук персоны', { exact: true }).first().click();
    await page.getByText('Создать лорбук', { exact: true }).click();
    const beforePreparedWrites = writes;
    const previousBinding = await page.evaluate(() => fixture.power.persona_description_lorebook);
    const previousContents = JSON.stringify(book);
    await page.getByLabel('Название нового лорбука', { exact: true }).fill('Канон');
    await page.getByRole('button', { name: 'Создать и привязать', exact: true }).click();
    await page.getByText('Лорбук с таким названием уже существует.', { exact: false }).waitFor();
    assert.equal(writes, beforePreparedWrites); assert.equal(JSON.stringify(book), previousContents);
    assert.equal(await page.evaluate(() => fixture.power.persona_description_lorebook), previousBinding);
    await page.getByLabel('Название нового лорбука', { exact: true }).fill('Persona Weaver Prepared');
    await page.getByRole('button', { name: 'Создать и привязать', exact: true }).click();
    await page.getByText('Лорбук создан и привязан к персоне.', { exact: true }).waitFor();
    assert.equal(writes, beforePreparedWrites + 1);
    assert.deepEqual(book, { entries: {} });
    assert.equal(await page.evaluate(() => fixture.power.persona_description_lorebook), 'Persona Weaver Prepared');
    assert.equal(await page.getByLabel('Лорбук персоны', { exact: true }).inputValue(), 'Persona Weaver Prepared');
    await page.evaluate(async () => { fixture.ctx.chatMetadata.integrity = 'auto-cancel'; await fixture.events.emit('chat_changed'); });
    await page.getByText('Автосоздание записей', { exact: true }).click();
    await page.getByLabel('Автоматический анализ этого чата', { exact: true }).check();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const beforeCancelledWrites = writes;
    await page.evaluate(() => fixture.events.emit('message_received'));
    await page.waitForFunction(() => fixture.calls === 2);
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.locator('.pc-activity').getByText('Автоанализ', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Отменить запрос', exact: true }).click();
    await page.waitForFunction(() => fixture.notices.some(notice => notice.level === 'error'));
    await page.waitForFunction(() => document.querySelector('.pc-activity')?.hidden);
    assert.equal(writes, beforeCancelledWrites, 'Explicit automatic cancellation must not write entries');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByRole('tab', { name: 'Сцены', exact: true }).click();
    await page.getByText('Успешных анализов пока нет.', { exact: true }).waitFor();
    await page.evaluate(() => {
        fixture.partialAnswer = structuredClone(fixture.answer);
        const good = fixture.partialAnswer.suggestions[0];
        fixture.partialAnswer.suggestions.push({ ...good, title: 'Сокращённая цитата <img src=x onerror=alert(1)>', evidence: [{ messageId: 0, quote: 'Мать [...] раны.' }] },
            { ...good, title: 'Ошибочный номер сообщения', evidence: [{ messageId: 99, quote: 'Мать' }] });
        fixture.ctx.generateRawData = async params => { fixture.lastPrompt = params.prompt; return { choices: [{ message: { content: JSON.stringify(fixture.partialAnswer) } }] }; };
    });
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.getByText('Корректных находок: 1.', { exact: false }).waitFor();
    await page.getByRole('tab', { name: 'Находки', exact: true }).click();
    await page.locator('.pc-validation-issues summary').first().getByText('Не прошли проверку источников: 2', { exact: true }).waitFor();
    assert.equal(await page.locator('.pc-validation-issues img').count(), 0, 'Invalid evidence diagnostics must escape model text');
    assert.equal(await page.locator('.pc-validation-issues blockquote').first().textContent(), 'Мать [...] раны.');
    await page.locator('.pc-validation-issues').getByText('Исходное сообщение', { exact: true }).click();
    assert.equal(await page.locator('.pc-validation-issues pre').textContent(), 'Мать научила меня зашивать раны.');
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Evidence diagnostics fit at 320px');
    if (screenshotDir) await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-weaver-evidence-issues.png') });
    await page.getByRole('tab', { name: 'Сцены', exact: true }).click();
    await page.getByText('Есть ошибки источников', { exact: false }).waitFor();
    await page.getByRole('tab', { name: 'Находки', exact: true }).click();
    await page.getByRole('button', { name: 'Навыки Ая Ожидает решения', exact: false }).click();
    const beforePartialWrites = writes;
    await page.getByRole('button', { name: 'Принять и сохранить', exact: true }).click();
    await page.getByText('Правка сохранена в лорбук.', { exact: true }).waitFor();
    assert.equal(writes, beforePartialWrites + 1, 'The valid proposal remains writable despite other invalid quotes');
    await page.reload();
    await page.evaluate(() => { fixture.ctx.chatMetadata.integrity = 'auto-cancel'; });
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByText('Не прошли проверку источников: 2', { exact: true }).waitFor();
    await page.getByText('Сохранено', { exact: true }).waitFor();
    await page.evaluate(() => {
        const good = fixture.answer.suggestions[0];
        fixture.ctx.generateRawData = async () => ({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ ...good, evidence: [{ messageId: 0, quote: 'Мать [...] раны.' }] }] }) } }] });
    });
    const beforeInvalidWrites = writes;
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.getByText('Корректных находок: 0.', { exact: false }).waitFor();
    await page.getByText('Нет находок, прошедших проверку источников.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Принять и сохранить', exact: true }).count(), 0);
    assert.equal(writes, beforeInvalidWrites, 'Entirely invalid evidence must never write entries');
    await page.evaluate(async () => {
        fixture.ctx.chatMetadata.integrity = 'auto-partial'; fixture.notices = []; fixture.partialCalls = 0;
        const good = { ...fixture.answer.suggestions[0], category: 'relationships', title: 'Отношения автоматического анализа' };
        const mixed = { suggestions: [good, { ...good, title: 'Ошибка автоматического анализа', evidence: [{ messageId: 0, quote: 'Мать [...] раны.' }] }] };
        fixture.ctx.generateRawData = async () => { fixture.partialCalls++; return { choices: [{ message: { content: JSON.stringify(mixed) } }] }; };
        await fixture.events.emit('chat_changed');
    });
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByText('Автосоздание записей', { exact: true }).click();
    await page.getByLabel('Автоматический анализ этого чата', { exact: true }).check();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const beforeAutoPartialWrites = writes;
    await page.evaluate(() => fixture.events.emit('message_received'));
    await page.waitForFunction(() => fixture.notices.some(notice => notice.message.includes('ошибками источников: 1')));
    assert.equal(writes, beforeAutoPartialWrites + 1, 'Automatic partial result saves only the validated user-established finding');
    assert.ok(Object.values(book.entries).some(entry => entry.comment === 'Отношения Ая'), 'Automatic saving follows the same persona section structure');
    const partialNotice = await page.evaluate(() => fixture.notices.at(-1));
    assert.ok(partialNotice.message.includes('Сохранено записей: 1'));
    assert.ok(partialNotice.message.includes('повторы приостановлены'));
    await page.evaluate(() => fixture.events.emit('message_received'));
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => fixture.partialCalls), 1, 'Partial validation must not cause paid automatic retries');
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByText('Не прошли проверку источников: 1', { exact: true }).waitFor();
    await page.getByText('Сохранено', { exact: true }).waitFor();
    const relationship = Object.values(book.entries).find(entry => entry.personaCanon?.category === 'relationships');
    const sectionCount = Object.keys(book.entries).length;
    const previousKeys = [...relationship.key];
    await page.evaluate(({ uid, content }) => {
        fixture.ctx.extensionSettings['Persona-Canon'].autoEnabled = false;
        fixture.ctx.chat.push({ mes: 'Я познакомилась с Рэн.', is_user: true, name: 'Ая' });
        const update = { suggestions: [{ target: String(uid), category: 'relationships', title: 'Рэн', content: content + '\n\nРэн: познакомилась с ней в дороге.',
            keywords: ['/рэн/iu', '/ren/iu'], reason: 'Новое знакомство.', conflict: false, evidence: [{ messageId: 2, quote: 'Я познакомилась с Рэн.' }] }] };
        fixture.ctx.generateRawData = async () => ({ choices: [{ message: { content: JSON.stringify(update) } }] });
    }, { uid: relationship.uid, content: relationship.content });
    await page.getByLabel('До', { exact: true }).fill('2');
    await page.getByLabel('До', { exact: true }).press('Tab');
    await page.waitForFunction(() => document.querySelector('.pc-range-row input:last-of-type')?.max === '2');
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#persona-canon-dialog[aria-busy]'));
    assert.match(await page.locator('.pc-status').textContent(), /Найдено предложений: 1\./);
    await page.getByRole('button', { name: 'Отношения Ая Ожидает решения', exact: false }).click();
    assert.equal(await page.locator('.pc-before').textContent(), relationship.content);
    assert.ok((await page.getByLabel('Предлагаемый текст', { exact: true }).inputValue()).includes('Рэн:'));
    await page.getByRole('button', { name: 'Принять и сохранить', exact: true }).click();
    await page.getByText('Правка сохранена в лорбук.', { exact: true }).waitFor();
    assert.equal(Object.keys(book.entries).length, sectionCount, 'Another NPC must update the shared relationship entry, not create a separate entry');
    assert.equal(book.entries[relationship.uid].comment, 'Отношения Ая');
    assert.equal(book.entries[relationship.uid].content, relationship.content + '\n\nРэн: познакомилась с ней в дороге.');
    assert.deepEqual(book.entries[relationship.uid].key, [...previousKeys, '/рэн/iu', '/ren/iu']);
    await page.evaluate(() => {
        const answer = { suggestions: [{ target: null, category: 'custom', categoryName: 'Страхи', categoryReason: 'Самостоятельная тема с причинами и способами справляться.', title: 'Страхи', content: 'Боится темноты.',
            keywords: ['/страх/iu', '/fear/iu'], reason: 'Новый факт.', conflict: false, evidence: [{ sourceId: '2:1' }] }] };
        fixture.ctx.generateRawData = async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    });
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await page.getByText('Найдено предложений: 1.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Страхи Ая Ожидает решения', exact: false }).click();
    await page.getByText('Предложение новой категории', { exact: true }).waitFor();
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Custom category controls fit at 320px');
    await page.getByLabel('Название категории', { exact: true }).fill('Страхи и тревоги');
    await page.getByRole('button', { name: 'Обновить предложение', exact: true }).click();
    await page.getByText('Предложение обновлено.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Страхи и тревоги Ая Ожидает решения', exact: false }).click();
    await page.getByRole('button', { name: 'Принять и сохранить', exact: true }).click();
    await page.getByText('Правка сохранена в лорбук.', { exact: true }).waitFor();
    const customEntry = Object.values(book.entries).find(entry => entry.personaCanon?.categoryName === 'Страхи и тревоги');
    assert.equal(customEntry.comment, 'Страхи и тревоги Ая');
    assert.equal(customEntry.personaCanon.origins[0].evidence[0].quote, 'Я познакомилась с Рэн.');
    assert.equal(customEntry.personaCanon.origins[0].evidence[0].sourceId, '2:1');
    await page.reload();
    await page.evaluate(() => { fixture.ctx.chatMetadata.integrity = 'auto-partial'; });
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByText('Страхи и тревоги Ая', { exact: true }).first().waitFor();
    await page.evaluate(async () => {
        const { loadState, saveState } = await import('/scripts/extensions/third-party/Persona-Canon/storage.mjs');
        const identity = JSON.stringify(['aya.png', 'character', 'npc.png', 'auto-partial']);
        const key = JSON.stringify(['fixture-account', identity]);
        const state = await loadState(key); const template = state.runs.at(-1);
        state.runs = Array.from({ length: 45 }, (_, id) => ({ ...structuredClone(template), id: `pager-${id}`, validationIssues: [],
            suggestions: id % 2 === 0 ? [{ ...structuredClone(template.suggestions[0]), status: id % 4 === 0 ? 'pending' : 'applied' }] : [] }));
        await saveState(key, state);
    });
    await page.reload();
    await page.evaluate(() => { fixture.ctx.chatMetadata.integrity = 'auto-partial'; });
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    const results = page.getByLabel('Результат анализа', { exact: true });
    await results.waitFor();
    assert.equal(await results.locator('option').count(), 20, 'Result selector must not grow beyond one page');
    assert.equal(await results.inputValue(), 'pager-44');
    await page.getByRole('button', { name: 'Раньше', exact: true }).click();
    assert.equal(await results.inputValue(), 'pager-24');
    await page.getByRole('button', { name: 'Раньше', exact: true }).click();
    assert.equal(await results.locator('option').count(), 5);
    assert.equal(await results.inputValue(), 'pager-4');
    await page.getByLabel('Показать результаты', { exact: true }).selectOption('findings');
    await page.getByText('Результатов: 23', { exact: false }).waitFor();
    await page.getByLabel('Показать результаты', { exact: true }).selectOption('pending');
    await page.getByText('Результатов: 12', { exact: false }).waitFor();
    assert.equal(await results.locator('option').count(), 12);
    await page.getByRole('tab', { name: 'Сцены', exact: true }).click();
    assert.equal(await page.locator('.pc-panel .pc-record').count(), 12);
    assert.equal(await page.locator('#persona-canon-dialog').evaluate(hasOverflow), false, 'Result filters fit at 320px');
    if (screenshotDir) await page.locator('#persona-canon-dialog').screenshot({ path: join(screenshotDir, 'persona-weaver-result-filters.png') });
    assert.deepEqual(errors, []);
    console.log('PASS browser: compact width/alignment; separate settings; collapsed limits; range preservation; cancellation; touch controls; entrypoint; IndexedDB reload; duplicate scene; edit/save; label/undo; three connections; session key; XSS; 1440/768/390/320px.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
