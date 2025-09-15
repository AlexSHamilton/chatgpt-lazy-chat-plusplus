# ChatGPT UI Mod — Lazy Chat++

**Fix long-thread lags, keep streaming smooth, and see how “heavy” your chat is.**  
This userscript keeps only the last _N_ turns visible, reveals older messages smoothly as you scroll up, stays stream-safe while the model is typing, and shows a live token estimate on the button (`[T:// …]`, ≈ 1.3 × spaces).

- **Chrome / Chromium + Tampermonkey**
- Modes: `hide` | `detach` | `cv`
- Stream-safe (no heavy DOM work during generation)
- Upward **infinite scroll** (8 turns per batch)
- One-click **show all / collapse**
- **Token counter** on the button (visible vs total)

---

## Why

Long ChatGPT threads (60k–100k tokens) can make Chrome unusable — typing lags, scrolling freezes, and you get _“Page Unresponsive”_.  
**Lazy Chat++** virtualizes the chat intelligently so you can keep working in the same thread without heavy UI jank.

**Different from common extensions:**
- Doesn’t break streaming — uses `content-visibility` or detaches only when safe.
- Smooth **infinite scroll up** (loads 8 turns at a time).
- Stream-safe: pauses work while the model is typing.
- Shows a **token estimate** to understand the weight of visible vs full chat.

---

## Install

1. Install **Tampermonkey**:  
   Chrome Web Store → <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>
2. Click this **Direct Install** link (Raw userscript):  
   **[https://raw.githubusercontent.com/<your-username>/<repo-name>/main/lazy-chat-plus-plus.user.js](https://raw.githubusercontent.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/main/lazy-chat-plus-plus.user.js)**
3. Tampermonkey will prompt to install → **Install**.
4. Open ChatGPT (<https://chat.openai.com> or <https://chatgpt.com>).

You’ll see a small button at bottom-right. It toggles between “show all” and “last N”, supports smooth upward reveal, stays stream-safe, and shows a live token estimate.

---

## How it works (brief)

- The script collapses older turns using one of three strategies:
  - **hide** — `display: none` on older turns (lightweight).
  - **cv** — `content-visibility: auto` (browser keeps layout cheap).
  - **detach** — actually detaches the oldest DOM nodes (most memory-friendly), chunked to avoid blocking.
- When the model is **streaming**, heavy work is **paused**, so typing stays smooth.
- When streaming **finishes**, the script performs chunked “archival” (detach/hide) to reach the target of “last N visible”.

**Button shows `[T:// …]`** — a live token estimate:
- **Collapsed:** visible subset (≈ `1.3 × spaces` across visible turns).
- **Expanded:** whole chat (visible + archived turns), computed incrementally and cached.

---

## Defaults

- **Mode:** `detach`  
- **Visible batch:** 8 (when revealing upward)  
- Stream off cooldown: 500 ms  
- Detach per tick: 50 nodes (post-stream)  
- Soft fold per tick: 40 nodes (during stream)  
- Token estimate: `tokens ≈ 1.3 × spaces` (fast, good enough as a scale indicator)

You can tweak those constants at the top of the script.

---

## Limitations / notes

- Token counter is an **estimate** (based on spaces) — accurate enough to track scale and avoid 100k+ token stalls.
- Very code-heavy chats (lots of whitespace) can slightly overestimate.
- Built for ChatGPT web UI; selectors may need updates if the site changes.

---

## Updates & issues

- Script file: `lazy-chat-plus-plus.user.js`  
- Please open **Issues** for bugs/ideas. PRs welcome if they keep the script stream-safe and lightweight.

If you want auto-updates in Tampermonkey, install from the **Raw** link above.  

## License
GPL-3.0-or-later

You’re free to use, modify, and redistribute this userscript under the terms of the GNU GPL v3 or any later version. Source code of modified versions must remain under GPL-compatible terms.
