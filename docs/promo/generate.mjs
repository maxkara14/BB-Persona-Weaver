/** Promotional layouts composed from rendered production UI on synthetic data.
 * No live ST account, chat, book, provider or key is accessed.
 * English layouts use English captions around the unchanged Russian interface.
 * Uses the same installed Playwright/Firefox as tests/browser.mjs.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = join(root, 'docs/assets');
const shots = join(assets, 'screens');
await mkdir(shots, { recursive: true });
const fixture = await readFile(join(root, 'tests/browser.mjs'), 'utf8');
const boundary = fixture.indexOf('try {\n    const page =');
if (boundary < 0) throw new Error('Browser fixture entry point changed. Review promo generator.');
const bootstrap = fixture.slice(0, boundary).replace(/const root = fileURLToPath\([^\n]+/, `const root = ${JSON.stringify(root)};`)
    + '\nexport { server, browser }; export function setBook(value) { book = value; }';
const { server, browser, setBook } = await import('data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const images = {};
const origins = [{ kind: 'chat', context: JSON.stringify(['aya.png', 'character', 'npc.png', 'demo']), chatName: 'Дорога к перевалу', date: '2026-11-06T09:00:00Z', id: 'demo' }];
const entry = (uid, category, title, content) => ({ uid, comment: title, content, key: ['/мир[аы]/iu', '/mira/iu'], order: 100, constant: false,
    personaCanon: { version: 1, section: true, persona: 'aya.png', category, origins } });
setBook({ entries: {
    0: entry(0, 'skills', 'Навыки Саё', 'Умеет перевязывать раны и накладывать шины. Училась у деревенской травницы.'),
    1: entry(1, 'relationships', 'Отношения Саё', 'Рэн: наставница, научившая Саё распознавать лекарственные растения. Саё обещала вернуться к ней после путешествия.'),
    2: entry(2, 'appearance', 'Внешность Саё', 'На левой ладони остался тонкий светлый шрам. Волосы в дороге собирает тёмной лентой.'),
} });

try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
        document.body.style.setProperty('--SmartThemeQuoteColor', '#64c5e8');
        document.body.style.setProperty('--SmartThemeBodyColor', '#e4edf3');
        document.body.style.setProperty('--SmartThemeBlurTintColor', '#14232d');
        fixture.ctx.name1 = 'Саё'; fixture.ctx.getCurrentChatId = () => 'Дорога к перевалу';
        fixture.ctx.getTokenCountAsync = async text => Math.ceil(text.length / 3.4);
        fixture.power.persona_description = 'Саё — молодая путешественница. Выросла в горной деревне, умеет оказывать первую помощь.';
        fixture.ctx.chatMetadata.integrity = 'demo';
        fixture.ctx.chat = [
            { mes: 'Ветер стих, и путники остановились у костра.', name: 'Рассказчик' },
            { mes: 'Ещё в деревне я научилась различать тысячелистник и зверобой. Рэн говорила: сначала изучи растение, а потом собирай.', name: 'Саё', is_user: true },
        ];
        fixture.ctx.extensionSettings['Persona-Canon'] = { mode: 'profile', profileId: 'demo', autoEnabled: false };
        fixture.profiles = [{ id: 'demo', name: 'Основная модель', model: 'Claude Sonnet' }];
        fixture.answer = { suggestions: [{ target: '0', category: 'skills', title: 'Навыки Саё', content: 'Умеет перевязывать раны и накладывать шины. Училась у деревенской травницы Рэн; различает тысячелистник и зверобой.',
            keywords: ['/перевяз\\p{L}*|шин[ауы]|тысячелистник|зверобой/iu', '/bandag\\p{L}*|splint\\p{L}*|yarrow|St[.]? John.s wort/iu'],
            reason: 'Раскрыты знания лекарственных растений и имя наставницы.', conflict: false, evidence: [{ sourceId: '1:1' }] }] };
    });
    const sheet = async (name, selectors, css = '', width = 640) => {
        const markup = await page.evaluate(selectors => selectors.map(selector => {
            const source = document.querySelector(selector);
            if (!source) throw new Error('Missing UI component: '+selector);
            const clone = source.cloneNode(true);
            const originals = source.querySelectorAll('textarea,input,select'); const copies = clone.querySelectorAll('textarea,input,select');
            originals.forEach((node, i) => {
                if (node.tagName === 'TEXTAREA') copies[i].textContent = node.value;
                if (node.tagName === 'INPUT' && node.checked) copies[i].setAttribute('checked', '');
                if (node.tagName === 'INPUT' && node.type !== 'checkbox') copies[i].setAttribute('value', node.value);
                if (node.tagName === 'SELECT') [...copies[i].options].forEach(option => option.selected = option.value === node.value);
            });
            return clone.outerHTML;
        }).join(''), selectors);
        const exportPage = await browser.newPage({ viewport: { width: width + 40, height: 1800 }, deviceScaleFactor: 2 });
        await exportPage.setContent(`<style>body{margin:0;background:#101820;--SmartThemeQuoteColor:#64c5e8;--SmartThemeBodyColor:#e4edf3;--SmartThemeBlurTintColor:#14232d}button,input,select,textarea{font:inherit}</style><style>${await readFile(join(root, 'style.css'), 'utf8')}</style><style>#persona-canon-dialog{display:block;position:relative;margin:0;width:${width}px;max-width:none;height:auto;max-height:none;border:0;border-radius:0;padding:22px;box-shadow:none;font-family:'Segoe UI',sans-serif}#persona-canon-dialog .pc-back{display:none}#persona-canon-dialog .pc-detail{display:block}${css}</style><div id="persona-canon-dialog">${markup}</div>`);
        await exportPage.locator('#persona-canon-dialog').screenshot({ path: join(shots, name + '.png') });
        await exportPage.close();
        images[name] = 'data:image/png;base64,' + (await readFile(join(shots, name + '.png'))).toString('base64');
    };
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
    await page.getByText('Найдено предложений: 1.', { exact: false }).waitFor();
    await page.locator('.pc-detail').waitFor();
    await page.locator('.pc-evidence').evaluate(node => node.open = true);
    await sheet('review', ['.pc-detail'], '#persona-canon-dialog .pc-detail > .pc-check,#persona-canon-dialog .pc-detail > .pc-field{display:none}');
    await sheet('overview', ['.pc-titlebar', '.pc-heading', '.pc-book-line', '.pc-connection', '.pc-scene', '.pc-tabs']);
    await page.getByRole('tab', { name: 'Записи', exact: true }).click();
    await page.locator('.pc-entry-toolbar').waitFor();
    await page.getByLabel('Выбрать для сжатия: Навыки Саё', { exact: true }).check();
    await page.getByLabel('Выбрать для сжатия: Отношения Саё', { exact: true }).check();
    await sheet('entries', ['.pc-entry-toolbar', '.pc-entry-record:nth-of-type(1)', '.pc-entry-record:nth-of-type(2)', '.pc-entry-record:nth-of-type(3)']);
    await page.evaluate(() => {
        fixture.ctx.extensionSettings['Persona-Canon'].mode = 'current';
        fixture.ctx.generateRawData = async params => ({ choices: [{ message: { content: JSON.stringify({ entries: JSON.parse(params.prompt[1].content).entries.map(item => ({ id: item.id, content: item.id === '1'
            ? 'Рэн — наставница Саё по лекарственным растениям. Саё обещала вернуться после путешествия.'
            : 'Перевязывает раны и накладывает шины; училась у деревенской травницы.' })) }) } }] });
    });
    await page.getByRole('button', { name: 'Сжать выбранные (2)', exact: true }).click();
    await page.locator('.pc-compression-result').first().waitFor();
    await page.locator('.pc-compression-result').first().locator('details').evaluate(node => node.open = true);
    await sheet('compression', ['.pc-compression-result']);
    await page.locator('.pc-compression-result').first().getByRole('button', { name: 'Принять сжатие', exact: true }).click();
    await page.getByText('Сжатие сохранено.', { exact: false }).waitFor();
    await page.getByRole('tab', { name: 'История', exact: true }).click();
    await page.locator('.pc-panel .pc-record').first().waitFor();
    await sheet('history', ['.pc-panel .pc-record']);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByText('Автосоздание записей', { exact: true }).click();
    await page.getByLabel('Автоматический анализ этого чата', { exact: true }).check();
    await page.getByLabel('Автоматически сохранять проверенные находки', { exact: true }).check();
    await page.getByLabel('Интервал сообщений', { exact: true }).fill('20');
    await page.getByLabel('Условие запуска', { exact: true }).focus();
    await page.getByText('Параметры записей', { exact: true }).click();
    await page.getByLabel('Приоритет новых записей', { exact: true }).selectOption('manual');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.evaluate(() => fixture.events.emit('message_received'));
    await page.waitForTimeout(1300); // The production automation uses a 1 s debounce; this batch is below its threshold.
    await page.getByRole('button', { name: 'Persona Weaver', exact: true }).click();
    await page.getByText('Автосоздание записей', { exact: true }).click();
    await page.evaluate(() => {
        document.querySelectorAll('.pc-settings-section').forEach(node => { node.dataset.promo = node.querySelector('summary')?.textContent ?? ''; });
    });
    await sheet('automation', ['details[data-promo="Автосоздание записей"]'], '#persona-canon-dialog .pc-provider-form > p:last-of-type,#persona-canon-dialog .pc-provider-form > button{display:none}');
    await page.getByText('Параметры записей', { exact: true }).click();
    await page.locator('details[data-promo="Параметры записей"]').evaluate(node => node.open = true);
    await sheet('options', ['details[data-promo="Параметры записей"]']);
    if (errors.length) throw new Error(errors.join('\n'));

    const common = `*{box-sizing:border-box}body{margin:0;color:#eaf5fa;background:#0b131b;font-family:'Segoe UI',sans-serif}.poster{position:relative;overflow:hidden}h1,h2,h3,p{margin:0}header,.content,footer{position:relative;z-index:1}.kicker{color:#78d3e6;letter-spacing:5px;font-size:19px;font-weight:600}.brand{font-size:66px;font-weight:700;letter-spacing:-2px}.version{border:1px solid #45717f;border-radius:99px;padding:13px 23px;font-size:20px;color:#99dcea}.top{display:flex;justify-content:space-between;align-items:center}.sub{color:#a8c2d0;line-height:1.5}.rule{height:1px;background:#26424e}.label{color:#83d2e4;text-transform:uppercase;letter-spacing:3px;font-size:19px;font-weight:650;margin-bottom:18px}.card{border:1px solid #294652;border-radius:18px;overflow:hidden;background:#101820;box-shadow:0 20px 70px #0003}.card img{display:block;width:100%;height:auto}.caption{font-size:23px;color:#a9c3d1;line-height:1.5;margin-top:18px}.small{font-size:18px;color:#7a9baa}.note{padding:25px 28px;background:#11212b;border:1px solid #294652;border-radius:14px;color:#b7ced8;line-height:1.6;font-size:23px}.note strong{color:#e9f7fc}.number{color:#62cbef;font-size:27px;font-weight:700;margin-right:12px}.weave{position:absolute;right:-110px;top:-190px;opacity:.45;pointer-events:none}.foot{display:flex;justify-content:space-between;align-items:center;gap:30px;font-size:19px;color:#88a9b9}footer{border-top:1px solid #294652;padding-top:28px}`;
    const weave = `<svg class="weave" width="1100" height="800" viewBox="0 0 1100 800" fill="none"><defs><linearGradient id="ink"><stop stop-color="#3b8aff"/><stop offset="1" stop-color="#77e6f4"/></linearGradient></defs>${[0,30,60].map(n=>`<path d="M${n} 80C960 0 130 660 1030 740M${n} 740C960 800 130 140 1030 60" stroke="url(#ink)" stroke-width="${n===30?2:1}"/>`).join('')}</svg>`;
    const shot = (name, label, caption = '') => `<section><div class="label">${label}</div><div class="card"><img src="${images[name]}" alt="${name}"></div>${caption ? `<p class="caption">${caption}</p>` : ''}</section>`;
    const words = {
        ru: { sub: 'Персона раскрывается в игре. Сохраните то, что делает её собой.', review: '01 · Новые факты — с источниками', reviewText: 'Сравните прежний текст и дополнение. Отредактируйте находку перед сохранением.', entries: '02 · Одна запись на раздел', entriesText: 'Навыки, отношения и внешность пополняются по мере истории.', compression: '03 · Меньше повторов, больше смысла', compressionText: 'Выберите записи, сравните варианты и примите подходящие. Каждую можно перегенерировать отдельно.', auto: '04 · Анализ по вашему ритму', autoText: 'По сообщениям или токенам. Автосохранение включается отдельно.', note: '<strong>Старые факты остаются в контексте.</strong><br>Раздел получает цельную обновлённую версию. Изменения можно восстановить через историю.', footer: 'Демонстрационные данные · Реальный интерфейс', version: 'ВЕРСИЯ' },
        en: { sub: 'Let your persona unfold through play. Keep what makes them who they are.', review: '01 · New facts, original sources', reviewText: 'Compare existing text with the proposed update. Edit each finding before saving.', entries: '02 · One growing entry per category', entriesText: 'Skills, relationships and appearance develop alongside your story.', compression: '03 · Less repetition, more meaning', compressionText: 'Select entries, compare proposals and accept what fits. Regenerate individual results.', auto: '04 · Analysis at your pace', autoText: 'Choose a message or token threshold. Autosave is optional.', note: '<strong>Previous facts stay in context.</strong><br>Review a complete updated section. Restore saved changes through history.', footer: 'Demo data · Actual interface shown in Russian', version: 'VERSION' },
    };
    const layout = async (html, width, filename, height = 900) => {
        const out = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await out.setContent(html); await out.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
        await out.evaluate(() => document.fonts.ready);
        const overflow = await out.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        if (overflow) throw new Error('Poster horizontal overflow: '+filename);
        await out.screenshot({ path: join(assets, filename), fullPage: true }); await out.close();
    };
    for (const lang of ['ru','en']) {
        const w = words[lang];
        const html = `<style>${common}.poster{width:1800px;padding:72px;background:radial-gradient(ellipse at 88% 0%,#14344370,transparent 45%),#0b131b}header{padding-bottom:42px}.brand{margin:20px 0}.sub{font-size:29px;max-width:1300px}.content{padding-top:42px;display:grid;grid-template-columns:1.06fr .94fr;gap:42px}.col{display:flex;flex-direction:column;gap:44px}.note{margin-top:0}footer{margin-top:48px}</style><div class="poster">${weave}<header><div class="kicker">SILLYTAVERN EXTENSION</div><div class="top"><h1 class="brand">BB Persona Weaver</h1><span class="version">${w.version} ${manifest.version}</span></div><p class="sub">${w.sub}</p></header><div class="rule"></div><main class="content"><div class="col">${shot('review',w.review,w.reviewText)}${shot('compression',w.compression,w.compressionText)}</div><div class="col">${shot('entries',w.entries,w.entriesText)}<div class="note">${w.note}</div>${shot('automation',w.auto,w.autoText)}</div></main><footer class="foot"><span>github.com/maxkara14/BB-Persona-Weaver</span><span>${w.footer}</span></footer></div>`;
        await layout(html, 1800, `persona-weaver-github-${lang}.png`);
    }
    const tg = `<style>${common}.poster{width:1600px;min-height:2000px;padding:64px;background:radial-gradient(ellipse at 85% 5%,#124b7a80,transparent 50%),radial-gradient(ellipse at 0% 80%,#0e436450,transparent 55%),#07121f}.brand{font-size:46px;letter-spacing:-1px}.kicker{font-size:16px;letter-spacing:4px}.version{font-size:17px}.headline{font-size:84px;line-height:1.08;letter-spacing:-3px;margin:35px 0 23px;font-weight:750}.headline span{color:#73d5f9}.sub{font-size:28px;max-width:1200px}.content{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:44px}.col{display:flex;flex-direction:column;gap:27px}.label{font-size:23px;letter-spacing:0;text-transform:none;margin-bottom:12px}.card{border-color:#3c91be;box-shadow:0 0 25px #237cbc22}.caption{font-size:24px}.chips{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:32px 0}.chip{padding:24px;border:1px solid #285477;border-radius:14px;background:#10263980;font-size:25px;line-height:1.4}.chip b{display:block;color:#8cddfa;font-size:26px;margin-bottom:5px}footer{margin-top:24px}.foot{font-size:18px}.tg-note{font-size:26px;line-height:1.45;color:#b7d2e1;padding:24px;border-left:3px solid #6bd3ff}</style><div class="poster">${weave}<header><div class="top"><div><div class="kicker">РАСШИРЕНИЕ ДЛЯ SILLYTAVERN</div><h1 class="brand">BB Persona Weaver</h1></div><span class="version">${manifest.version}</span></div><h2 class="headline">Развивайте персону<br><span>по ходу истории.</span></h2><p class="sub">Новые навыки, связи и черты — в лорбуке персоны.<br>Начните с короткого описания. Остальное раскроется в игре.</p></header><main class="content"><div class="col">${shot('review','<span class="number">01</span>Найдите новое в сцене')}<div class="tg-note">Источники рядом с находкой.<br>Вы решаете, что станет каноном.</div>${shot('history','Передумали? Верните прошлую версию')}</div><div class="col">${shot('entries','<span class="number">02</span>Дополняйте разделы')}${shot('compression','<span class="number">03</span>Сжимайте без лишних повторов')}</div></main><div class="chips"><div class="chip"><b>Ваш ритм</b>Ручной и автоанализ</div><div class="chip"><b>Ваш контроль</b>Проверка и история</div><div class="chip"><b>Ваш лорбук</b>Ключи RU / EN</div></div><footer class="foot"><span>github.com/maxkara14/BB-Persona-Weaver</span><span>Реальный интерфейс · Демонстрационные данные</span></footer></div>`;
    await layout(tg, 1600, 'persona-weaver-telegram-ru.png');
    await writeFile(join(assets, 'promo-manifest.json'), JSON.stringify({ version: manifest.version, source: 'Production UI rendered with the isolated browser fixture', screenshots: Object.keys(images), english: 'English captions; Russian production interface' }, null, 2) + '\n');
    console.log('Generated Telegram RU and GitHub RU/EN posters from production UI.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
