# ChatGPT UI Mod — Lazy Chat++ + Translate Layout Patch

**Fix long-thread lags in ChatGPT chats and improve the `/translate` page layout.**  
This userscript does two different jobs depending on the page:

- **Chat pages** (`chatgpt.com`, `chat.openai.com`)  
  Keeps only the last _N_ turns visible, reveals older messages smoothly as you scroll up, stays stream-safe while the model is typing, and shows a live token estimate on the button (`[T:// …]`, ≈ 1.3 × spaces).

- **Translate page** (`https://chatgpt.com/translate/`)  
  Disables the lazy-chat virtualization logic entirely and applies a dedicated responsive layout patch:
  - in **desktop mode**, source and translation panes are stretched to about **4/5 of the visible screen height**
  - in **portrait / narrow mode** (`< 768px` wide), the header and language controls are compressed to about **1/6 of the viewport height**, while the remaining **5/6** are given to the source + translation panes

---

## Features

### Chat pages
- **Chrome / Chromium + Tampermonkey**
- Modes: `hide` | `detach` | `cv`
- Stream-safe (no heavy DOM work during generation)
- Upward **infinite scroll** (8 turns per batch)
- One-click **show all / collapse**
- **Token counter** on the button (visible vs total)

### Translate page
- Lazy chat logic is **disabled**
- Dedicated responsive UI patch for `https://chatgpt.com/translate/`
- Desktop layout makes both text panes much taller and more usable
- Mobile / portrait layout prioritizes source and translation areas over oversized heading / controls

---

## Why

Long ChatGPT threads (60k–100k tokens) can make Chrome unusable — typing lags, scrolling freezes, and you get _“Page Unresponsive”_.  
**Lazy Chat++** virtualizes the chat intelligently so you can keep working in the same thread without heavy UI jank.

At the same time, the current ChatGPT **Translate** page wastes a lot of vertical space:
- in desktop mode the source / result panes can feel like narrow “letterbox” windows
- in portrait mode the heading and language controls take too much space compared to the actual text areas

This userscript fixes both problems in one place:
- **chat pages** get virtualization and token estimates
- **translate page** gets a layout-only patch optimized for readability and usable editing space

---

## Different from common extensions

### For chat
- Doesn’t break streaming — uses `content-visibility` or detaches only when safe
- Smooth **infinite scroll up** (loads 8 turns at a time)
- Stream-safe: pauses work while the model is typing
- Shows a **token estimate** to understand the weight of visible vs full chat

### For translate
- Does **not** inject the lazy-chat button or folding logic into `/translate`
- Uses a separate layout patch instead of trying to virtualize non-chat UI
- Improves vertical space distribution on both desktop and mobile

---

## Install

1. Install **Tampermonkey**:  
   Chrome Web Store → <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>

2. Click this **Direct Install** link (Raw userscript):  
   **[https://raw.githubusercontent.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/main/lazy-chat-plus-plus.user.js](https://raw.githubusercontent.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/main/lazy-chat-plus-plus.user.js)**

3. Tampermonkey will prompt to install → **Install**

4. Open ChatGPT:
   - chats: <https://chatgpt.com> or <https://chat.openai.com>
   - translate: <https://chatgpt.com/translate/>

---

## How it works

## Chat mode

On normal ChatGPT chat pages, the script collapses older turns using one of three strategies:

- **hide** — `display: none` on older turns (lightweight)
- **cv** — `content-visibility: auto` (browser keeps layout cheap)
- **detach** — actually detaches the oldest DOM nodes (most memory-friendly), chunked to avoid blocking

When the model is **streaming**, heavy work is **paused**, so typing stays smooth.

When streaming **finishes**, the script performs chunked “archival” (detach/hide) to reach the target of “last N visible”.

### Button shows `[T:// …]`
A live token estimate:
- **Collapsed:** visible subset (≈ `1.3 × spaces` across visible turns)
- **Expanded:** whole chat (visible + archived turns), computed incrementally and cached

---

## Translate mode

On `https://chatgpt.com/translate/`, the chat virtualization logic is completely **skipped**.

Instead, the script applies a layout patch to the current Translate UI:

### Desktop
- the main content area is widened
- the two text panes are forced into a taller side-by-side layout
- source and translated text areas get about **80% of the visible viewport height**
- the result is a much more practical editing / review area

### Mobile / portrait (`< 768px`)
- the heading is reduced significantly
- language selectors and swap controls are compacted
- top UI occupies roughly **1/6** of the vertical viewport
- source and translation panes share the remaining **5/6**
- suggestion/action buttons are hidden to preserve usable text space

---

## Defaults

### Chat
- **Mode:** `detach`
- **Visible batch:** 8 (when revealing upward)
- Stream off cooldown: 500 ms
- Detach per tick: 50 nodes
- Token estimate: `tokens ≈ 1.3 × spaces`

### Translate
- Lazy chat features: **disabled**
- Desktop pane height target: about **4/5 of visible screen height**
- Portrait layout threshold: **below 768px width**
- Mobile top-area target: about **1/6 of viewport height**
- Remaining viewport height goes primarily to the source / translation panes

You can tweak the constants at the top of the script.

---

## Page behavior summary

| Page | Behavior |
|---|---|
| `https://chatgpt.com/*` | Lazy chat virtualization enabled |
| `https://chat.openai.com/*` | Lazy chat virtualization enabled |
| `https://chatgpt.com/translate/` | Lazy chat virtualization disabled, responsive translate layout patch enabled |

---

## Limitations / notes

- Token counter is an **estimate** (based on spaces), not an exact tokenizer result
- Very code-heavy chats can slightly overestimate
- Built for the current ChatGPT web UI; selectors may need updates if the site changes
- The Translate patch depends on the current DOM structure of the ChatGPT Translate page and may need updates if OpenAI changes that layout
- The `/translate` patch is currently targeted specifically at `https://chatgpt.com/translate/`

---

## Updates & issues

- Script file: `lazy-chat-plus-plus.user.js`
- Please open **Issues** for bugs / ideas
- PRs are welcome as long as they keep the script lightweight and stream-safe

If you want auto-updates in Tampermonkey, install from the **Raw** link above.

---

## License

GPL-3.0-or-later

You’re free to use, modify, and redistribute this userscript under the terms of the GNU GPL v3 or any later version. Source code of modified versions must remain under GPL-compatible terms.
