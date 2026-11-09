# BB Persona Weaver — обновления / changelog

[Русский](#русский) · [English](#english)

## Русский

### Названия лорбуков и уведомления — 9 ноября 2026

- Автоматически создаваемые лорбуки получают название «Persona Weaver — имя персоны» вместо UUID; если название занято, добавляется номер (2), (3) и далее. Существующие книги не переименовываются и не перезаписываются.
- После создания и привязки книги появляется уведомление с её названием.
- Добавлено уведомление о завершении ручного анализа с числом находок или отсутствием изменений. Заголовок уведомления автоанализа также явно сообщает о завершении.

### Источники, результаты анализа и общие настройки — 9 ноября 2026

- Убран лимит в 12 ссылок на источники. Находки с отсутствующими или неверными ссылками остаются в очереди с предупреждением; их можно редактировать и принимать вручную. Корректные ссылки сохраняются, автосохранение пропускает проблемную находку.
- Предупреждения об источниках больше не отменяют завершённый анализ и не вызывают повторные автоматические запросы. Ранее отклонённые находки требуют повторного анализа.
- Пустой список без статуса больше не считается успешной проверкой сцены. Для отсутствия изменений модель должна вернуть `no_changes` с объяснением; `unable_to_analyze` и явные признаки отказа API не создают отметку обработки. Непустые ответы прежних пользовательских промптов поддерживаются.
- Настройки автоанализа и автосохранения общие для всех чатов. Лорбук выбирается у персоны, а результаты и история остаются отдельными для каждого чата.
- Проверено сохранение обработанных отрезков после перезагрузки, смены чата и книги. Редактирование или свайп сообщения делает весь исходный отрезок устаревшим, не удаляя журнал.
- Обновлены README на русском и английском, регрессионные проверки и осенняя горизонтальная обложка для Telegram.

### Восстановление ключей и специальные пробелы — 9 ноября 2026 (без изменения версии)

- Неверные или отсутствующие regex-ключи RU / EN больше не отклоняют весь ответ модели. Находка остаётся в очереди с объяснением ошибки; остальные корректные находки доступны для сохранения.
- Добавлена кнопка «Перегенерировать ключи»: отдельный запрос исправляет только ключи выбранной находки, сохраняя её текст и источники. Ключи также можно исправить вручную. Сохранение проблемной находки заблокировано до успешной проверки.
- Автоматизация пропускает находки с ошибками ключей и приостанавливает повторы для проверки пользователем. Пока такие находки ожидают исправления, сцена не отмечается полностью обработанной.
- U+2800, специальные пробелы и распространённые невидимые заполнители нормализуются в синтаксисе JSON, тексте находок, результатах сжатия и отображаемом тексте. Новые генерируемые regex-разделители учитывают эти символы.
- Проверка старого формата цитат допускает различия только в поддерживаемых заменителях пробела, сохраняя исходный непрерывный фрагмент. Источники через `sourceId`, исходный чат, идентификаторы и прежние ручные ключи не переписываются.
- Добавлены регрессионные проверки обработки Unicode, восстановления ключей, сохранения и отмены, а также браузерный сценарий восстановления ключей на компьютере и телефоне.

### 0.4.0 — 6 ноября 2026

- Добавлено сжатие выбранных записей лорбука: до 20 записей одним запросом через выбранное подключение, с отдельным промптом и проверкой бюджета.
- Результаты сжатия можно проверить, отредактировать, перегенерировать по отдельности, сохранить или отклонить. Сжатие меняет только текст; сохранённые изменения можно отменить через историю.
- Обновлены выбор записей и элементы управления для небольших экранов, руководства на двух языках и иллюстрации интерфейса.

### 0.3.0 — 5 ноября 2026

- Введена структура «одна запись на раздел персоны»: внешность, привычки, навыки, биография, ценности и отношения. Модель получает полный существующий раздел и предлагает его обновление вместо создания разрозненных записей.
- Добавлены пользовательские категории с обязательным ручным согласованием и возможностью направить находку в существующий раздел.
- Подтверждение источников переведено на ссылки `sourceId`: оригинальные абзацы и авторство извлекаются расширением. Старый формат дословных цитат сохранён для совместимости.
- Ошибка источника отклоняет только соответствующее предложение. Корректные находки остаются доступны, а автоматические повторы приостанавливаются до проверки.
- Добавлены страницы результатов по 20 анализов, фильтры и отдельная настройка сохранения значимых событий персоны.

### 0.2.5 — 4 ноября 2026

- Добавлены уведомления о начале и результате автоматического анализа.
- Уведомления различают сохранённые записи, находки для ручной проверки и операции с неподтверждённым сохранением.
- Ошибки автоматизации показываются без раскрытия ключа API; сбой уведомления не мешает обработке находок.

### 0.2.4 — 4 ноября 2026

Первая версия, зафиксированная в истории этого репозитория.

- Анализ выбранной сцены с находками о пользовательской персоне, подтверждающими цитатами и проверкой перед сохранением.
- Создание и обновление записей лорбука персоны, редактирование текста и ключей активации, метки «Общее» / «Из чата» и история с отменой изменений.
- Три подключения: текущее подключение SillyTavern, профиль Connection Manager или отдельный API.
- Автоматический анализ по числу сообщений или токенов с отдельно включаемым автосохранением.
- Защита от применения устаревших результатов после смены чата или изменения исходных сообщений.

## English

### Lorebook names and notifications — November 9, 2026

- Automatically created lorebooks use “Persona Weaver — persona name” instead of a UUID, adding (2), (3) and so on when needed. Existing books are not renamed or overwritten.
- A notification confirms lorebook creation and binding by name.
- Manual analysis now shows a completion notification with the finding count or a no-change result. Automatic completion also has an explicit notification title.

### Sources, analysis outcomes and global settings — November 9, 2026

- Removed the twelve-reference limit. Findings with missing or invalid references stay in the review queue with a warning and can be edited and accepted manually. Valid references are retained; autosave skips the affected finding.
- Source warnings no longer invalidate completed analysis or trigger automatic retries. Previously rejected findings require a new analysis.
- A bare empty list no longer marks a scene as processed. No-change results require an explicit `no_changes` status and explanation; `unable_to_analyze` and explicit API refusal indicators do not create coverage. Non-empty responses from older custom prompts remain supported.
- Automatic analysis and autosave settings apply across chats. The lorebook follows the selected persona; results and history remain separate for each chat.
- Verified coverage persistence after reload and chat or book changes. Editing or swiping a message invalidates the original analyzed range without deleting its journal.
- Updated both READMEs, regression coverage and the autumn landscape Telegram cover.

### Key repair and special spaces — November 9, 2026 (no version change)

- Invalid or missing RU / EN regex keys no longer reject the entire model response. The finding stays in the review queue with an explanation; other valid findings remain available to save.
- Added “Перегенерировать ключи” (Regenerate keys): a separate request repairs only the selected finding's keys, preserving its text and evidence. Keys can also be corrected manually. Saving the affected finding is blocked until validation succeeds.
- Automation skips findings with key errors and pauses retries for user review. The scene is not marked fully processed while these findings await repair.
- U+2800, special spaces and common invisible fillers are normalized in JSON syntax, finding text, compression results and displayed text. Newly generated regex separators recognize these characters.
- Legacy quotation validation tolerates differences only in supported space substitutes while retaining the original contiguous source excerpt. `sourceId` evidence, original chat messages, identifiers and existing manual keys are not rewritten.
- Added regression coverage for Unicode handling, key repair, saving and undo, plus a browser key-repair scenario for desktop and mobile.

### 0.4.0 — November 6, 2026

- Added compression of selected lorebook entries: up to 20 entries in one request through the selected connection, with a separate prompt and budget validation.
- Compression results can be reviewed, edited, regenerated individually, saved or rejected. Compression changes content only; saved changes can be undone through history.
- Updated entry selection and controls for small screens, bilingual guides and interface illustrations.

### 0.3.0 — November 5, 2026

- Introduced one lorebook entry per persona section: appearance, habits, skills, biography, values and relationships. The model receives the complete existing section and proposes an update rather than creating scattered entries.
- Added custom categories with mandatory manual approval and the option to route a finding into an existing section.
- Switched evidence to `sourceId` references: the extension retrieves original paragraphs and authorship. Legacy verbatim quotations remain supported.
- An evidence error rejects only the affected proposal. Valid findings remain available, and automatic retries pause for review.
- Added result pages of 20 analyses, filters and a separate setting for retaining significant personal events.

### 0.2.5 — November 4, 2026

- Added notifications for automatic analysis start and completion.
- Notifications distinguish saved entries, findings awaiting manual review and operations with unconfirmed saves.
- Automation errors are shown without exposing the API key; notification failures do not interrupt finding processing.

### 0.2.4 — November 4, 2026

The earliest version recorded in this repository's history.

- Analysis of selected scenes for user-persona findings, with supporting quotations and review before saving.
- Creation and updating of persona lorebook entries, editable content and activation keys, General / From chat labels and change history with undo.
- Three connections: the current SillyTavern connection, a Connection Manager profile or a separate API.
- Automatic analysis triggered by message or token counts, with separately enabled automatic saving.
- Protection against applying stale results after switching chats or editing source messages.
