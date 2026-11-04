<div align="center">

# 🪶 BB Persona Weaver

**Let your persona unfold through play. Keep the details worth remembering.**

**0.2.4** · SillyTavern · Private testing

[Русский](README.md) · **English** · [Quick start](#-quick-start) · [Automation](#-automatic-entries) · [Tests](docs/testing.md)

</div>

---

A **SillyTavern** extension that extracts new facts about your user persona from roleplay and proposes entries for the persona's lorebook: habits, skills, appearance, history, values and relationships.

Start with a short persona description, play, and build the rest along the way. **Weaver shows source quotations and updates existing sections**, helping the book grow with your story.

> Open **the magic wand → Persona Weaver**.
> The installed extension is listed as **BB Persona Weaver**. Settings live inside its window under **⚙**.

## ✨ Features

| | What Weaver does |
|---|---|
| 🔎 **Scene analysis** | Extracts durable new details from an explicit message range |
| 🧵 **Evolving sections** | Creates topics or proposes complete updates to existing entries |
| 💬 **Evidence** | Shows exact quotations, message numbers and authorship |
| ✍️ **Review** | Lets you edit text, activation keys and entry settings before saving |
| 🌐 **RU / EN regex** | Requests Russian and English activation keys with Unicode boundaries |
| 📖 **One lorebook** | Uses an existing persona book or creates and binds a new one |
| 🏷️ **Labels** | Tracks general facts and contributions from individual chats |
| ⚙️ **Three connections** | Current ST connection, Connection Manager profile or a separate API |
| ⏱️ **Automation** | Analyzes after a message/token threshold; saving automatically is optional |
| ↩️ **Recovery** | Keeps before/after versions, supports rollback and resumes uncertain saves |

A compact dark interface with a theme-derived accent, stable window geometry and small-screen support. The current interface is in Russian.

## 📦 Installation

This repository is currently **private**. You need repository access and an authenticated GitHub CLI.

From the SillyTavern root:

```sh
gh repo clone maxkara14/BB-Persona-Weaver public/scripts/extensions/third-party/BB-Persona-Weaver
```

Reload with **Ctrl+F5**, then open the magic wand. If you already have a local installation, keep using it instead of installing a second copy.

## 🚀 Quick start

1. Open a saved chat and select your user persona.
2. Open **the magic wand → Persona Weaver**.
3. Choose a connection and model under **⚙**, then click **«Готово»** (Done).
4. Set the inclusive message range and click **«Анализировать»** (Analyze). Message numbers start at zero.
5. Review a suggestion, its sources and proposed text. Adjust its keys and settings as needed.
6. Click **«Принять и сохранить»** (Accept and save). If the persona has no book, one is created on the first save.

Unless automatic saving is enabled, analysis alone does not change the lorebook. A valid empty result still marks a scene as analyzed.

### Prepare a book in advance

Open **⚙ → «Лорбук персоны» → «Создать лорбук»**, enter a name and click **«Создать и привязать»** (Create and bind).

Existing names are rejected instead of overwritten. A context change before binding prevents attaching the book to another persona. The previously bound book is not deleted.

## 🧠 What becomes canon

Initial categories cover **appearance**, **habits and preferences**, **skills and limitations**, **history and family**, **values and boundaries**, and **relationships**. Empty sections are not created upfront.

The prompt asks the model to distinguish established facts from isolated actions, temporary emotions, opinions and guesses. This is a model instruction, not a guarantee: review the evidence and proposed text.

Only entries managed by Weaver for this persona are updated. The core persona description and unrelated entries are not rewritten.

### One book, informational labels

**General** and **From chat** labels organize the same book. A section can retain contributions from multiple chats.

Labels **do not restrict activation**. Entries use ordinary ST activation wherever the book is connected. The Entries filter only changes the displayed list.

## 🌐 Output language and activation keys

The default prompt is **English**. Entry titles and content should follow the **predominant narrative language of the persona description**, rather than the interface or current scene. For ambiguous mixed descriptions, the prompt falls back to the existing entry, then the user's messages. Review explanations remain in Russian.

Every suggestion must supply **two valid regex keys — RU and EN**, regardless of the entry language:

```text
/(?:^|[^\p{L}\p{N}_])(?:перевяз\p{L}*|зашива\p{L}*\s+ран\p{L}*)(?=$|[^\p{L}\p{N}_])/iu
/(?:^|[^\p{L}\p{N}_])(?:bandag\p{L}*|stitch\p{L}*\s+wounds?)(?=$|[^\p{L}\p{N}_])/iu
```

This illustrates the format, not a universal preset. Each complete expression occupies its own line; commas inside quantifiers such as `{1,3}` remain part of the key. Invalid generated keys stop processing before saving or marking coverage.

Edit instructions under **⚙ → «Промпт сборки и ключей»**. The JSON contract and evidence validation remain required. **«Восстановить промпт»** restores the current default; existing custom instructions are not replaced automatically.

## 🔌 Connections

| Source | Setup |
|---|---|
| **Current connection** | Uses the active ST connection; wait for the main reply to finish |
| **Connection profile** | Select a Connection Manager profile; text profiles use native prompt conversion |
| **Separate API** | Enter an OpenAI-compatible base URL, key and model; load a model list or enter its ID manually |

Use a base URL such as `https://example.com/v1`. URLs ending in `/chat/completions` or `/models` are also recognized. Direct browser requests require the API to allow **CORS**.

**The separate API key stays in memory until the page reloads.** The URL and model persist; the key is excluded from settings, prompts and journal exports. Errors never silently switch providers.

Timeout, response length and the combined context budget are under **«Дополнительно»**. Token estimates use the current ST tokenizer and may differ from the selected model.

## ⏱️ Automatic entries

Under **⚙ → «Автосоздание записей»**:

1. Enable analysis for the current chat.
2. Choose a message or token threshold.
3. Optionally enable saving validated suggestions automatically.

Automation runs **after replies, while the Weaver window is closed**. Without automatic saving, suggestions wait in the queue. Conflicts and details based on model-authored messages always require manual review.

Successfully processed messages are not requested again without an explicit rerun. An error pauses automatic retries; after fixing it, reset the automation error in settings. Processing resumes after the next reply.

## 🎛️ Entry settings

Global defaults and individual suggestions expose **constant activation**, the native **vectorization flag**, exclusion from recursive scanning, and prevention of recursion from the entry.

Normal activation means constant activation and vectorization are both off. Defaults apply to new entries; updates preserve existing settings. Existing keys are retained and new keys are added without exact duplicates. You can edit the final set.

## 🗂️ Scenes, history and recovery

| Tab | Purpose |
|---|---|
| **«Находки»** | Review, edit and accept suggestions |
| **«Записи»** | Browse managed entries and contribution labels |
| **«Сцены»** | Inspect successful analyses, including empty results |
| **«История»** | View versions, undo changes, recover unfinished saves and export the journal |

Edits and swipes invalidate affected analyses. Overlapping ranges and unprocessed gaps are tracked. Each chat or branch has its own journal.

Before saving, Weaver rereads the book and compares the baseline entry. Later manual changes block replacement or rollback. If a save acknowledgement is lost, **«Проверить / повторить незавершённую запись»** checks the book before retrying, preventing duplicate creation.

Undoing creation deletes the new entry only after confirmation in the interface.

## 🔒 Storage and current limits

- Lorebooks are saved on the ST server using native World Info storage.
- Queues, source excerpts and history live in the current browser's IndexedDB, separated by ST account, persona and chat. They do not synchronize across browsers.
- Clearing site data removes the local journal, not the server lorebook. Journal exports contain roleplay text.
- History is not silently trimmed. New saves stop with an error once a context exceeds 10 million characters.
- ST saves an entire book without an atomic version check. Use one editing tab; simultaneous external edits are not fully protected.
- Adopting unrelated existing entries and transferring queues between browsers are not implemented yet.

> **Preview status:** development checks use an isolated fixture. Provider compatibility and extraction quality still need testing with your own roleplay.

## 🧪 Development

[Test setup and source layout](docs/testing.md) · [ST integration notes](docs/integration-notes.md)

The internal `Persona-Canon` identifiers and storage namespace are retained for compatibility with existing data.
