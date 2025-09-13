// ==UserScript==
// @name         ChatGPT Lazy Chat++ (stream-safe + tokens badge)
// @namespace    chatgpt-lazy
// @version      1.0.1
// @description  Keeps only the last N chat turns visible with smooth upward reveal. Stream-safe virtualization (no heavy work while generating). Modes: hide | detach | cv. Button shows estimated tokens as [T:// …] (≈1.3 × spaces).
// @author       AlexSHamilton
// @homepage     https://github.com/AlexSHamilton/chatgpt-lazy-chat-plusplus
// @supportURL   https://github.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/issues
// @downloadURL  https://raw.githubusercontent.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/main/lazy-chat-plus-plus.user.js
// @updateURL    https://raw.githubusercontent.com/AlexSHamilton/chatgpt-lazy-chat-plusplus/main/lazy-chat-plus-plus.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-end
// @grant        none
// @noframes
// @license      GPL-3.0-or-later
// ==/UserScript==

/* SPDX-License-Identifier: GPL-3.0-or-later */
/*!
 * ChatGPT Lazy Chat++ — Userscript
 * Copyright (C) 2025 Alex S Hamilton
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

(function () {
  'use strict';

  // ====== Settings ======
  const MODE = 'detach';            // 'hide' | 'detach' | 'cv'  (mode label on the button is replaced by T://)
  const BATCH = 8;                  // upward auto-reveal batch size
  const OBS_DEBOUNCE_MS = 250;
  const TOP_REVEAL_THRESHOLD = 120; // px from top to trigger reveal
  const BTN_ID = 'cgpt-lazy-btn';

  // Stream safety
  const STREAM_SAFE = true;          // do not run heavy detach/anchor/large loops while streaming
  const STREAM_OFF_COOLDOWN = 500;   // after the Stop button disappears, wait a bit before full processing

  // Anti-freeze chunking
  const MAX_DETACH_PER_TICK = 50;    // how many nodes to detach per tick (after streaming)
  const STREAM_SOFT_CHUNK   = 40;    // how many nodes to mark with .cv per tick (during streaming)

  // Selectors
  const TURN_SELECTOR = [
    '[data-testid^="conversation-turn"]',
    'article[data-turn-id]',
    'article[data-turn]',
    'div[data-testid^="conversation-turn"]',
    'li[data-testid^="conversation-turn"]'
  ].join(',');

  // "Stop streaming" button — primary streaming flag
  const STOP_BTN_SEL =
    '#composer-submit-button[data-testid="stop-button"],' +
    '[data-testid="stop-button"],' +
    'button[aria-label*="stop streaming" i]';

  // ====== State ======
  let expanded = false;
  let visibleCount = BATCH;
  let hiddenStore = [];            // detach store: [{ placeholder, node }]
  let observer = null;
  let observerRoot = null;
  let isRevealing = false;

  // Scroll
  let scrollContainer = null;
  let scrollAttachedTo = null;

  // Early-exit metrics for apply()
  let lastMetrics = { total: -1, desiredVisible: -1, mode: MODE, expanded };

  // Streaming state
  let isStreaming = false;
  let streamFlipTimer = null;
  let softJobScheduled = false;

  // Track current URL (SPA navigation)
  let lastURL = location.href;

  // ====== Token estimator (≈ 1.3 × spaces) ======
  const TOKEN_RATIO = 1.3;               // 1 word ≈ 1.3 tokens; tokens ≈ 1.3 × spaces
  const TOKENS_PER_TICK = 20;            // nodes to compute per tick when missing cache
  let tokenCache = new WeakMap();        // NOTE: let (so we can reset on URL change)
  const lastTokens = { visible: null, total: null };
  let wantTokensVisible = false, wantTokensTotal = false, tokenJobQueued = false;

  // ====== Utils ======
  const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };

  const hasStopButton = () => !!document.querySelector(STOP_BTN_SEL);

  function ensureStyle() {
    if (document.getElementById('cgpt-lazy-style')) return;
    const s = document.createElement('style');
    s.id = 'cgpt-lazy-style';
    s.textContent = `
      .lazy-turn-hidden { display: none !important; }
      .lazy-turn-cv { content-visibility: auto; contain-intrinsic-size: 1px 800px; }
      #${BTN_ID}{
        position: fixed; right: 8px; bottom: 8px; z-index: 2147483647;
        padding: 6px 12px; border-radius: 8px; border: none;
        background: #222; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,.25);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        backdrop-filter: saturate(180%) blur(6px);
        -webkit-backdrop-filter: saturate(180%) blur(6px);
      }
    `;
    document.head.appendChild(s);
  }

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.addEventListener('click', toggle);
    document.body.appendChild(b);
  }

  function getTurns() { return Array.from(document.querySelectorAll(TURN_SELECTOR)); }

  function getAllTurnNodes() {
    return hiddenStore.length ? hiddenStore.map(h => h.node).concat(getTurns()) : getTurns();
  }

  function getTotalTurns() { return getTurns().length + hiddenStore.length; }

  function formatTokens(n) {
    if (n == null) return '…';
    if (n >= 1e6)  return (n / 1e6).toFixed(n % 1e6 >= 1e5 ? 1 : 0) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(n % 1e3 >= 100 ? 1 : 0) + 'k';
    return String(n);
  }

  function countSpaces(text) {
    // Count space, tab, line breaks and NBSP
    let c = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 160) c++;
    }
    return c;
  }

  function tokensForNode(node) {
    let rec = tokenCache.get(node);
    if (!rec || rec.dirty) {
      const text = node.textContent || '';
      const spaces = countSpaces(text);
      rec = { tokens: Math.round(spaces * TOKEN_RATIO), dirty: false };
      tokenCache.set(node, rec);
    }
    return rec.tokens;
  }

  function sumTokensForNodes(nodes, done) {
    let sum = 0, i = 0;
    (function step() {
      let work = 0;
      for (; i < nodes.length; i++) {
        const n = nodes[i];
        let rec = tokenCache.get(n);
        if (!rec || rec.dirty) {
          // Compute missing entries in small chunks to avoid blocking UI
          const text = n.textContent || '';
          const spaces = countSpaces(text);
          rec = { tokens: Math.round(spaces * TOKEN_RATIO), dirty: false };
          tokenCache.set(n, rec);
          work++;
        }
        sum += rec.tokens;
        if (work >= TOKENS_PER_TICK) { setTimeout(step, 0); return; }
      }
      done(sum);
    })();
  }

  function scheduleTokens(kind) {
    if (kind === 'visible' || kind === 'both') wantTokensVisible = true;
    if (kind === 'total'   || kind === 'both') wantTokensTotal   = true;
    if (tokenJobQueued) return;
    tokenJobQueued = true;
    setTimeout(runTokenJob, 0);
  }

  function runTokenJob() {
    tokenJobQueued = false;
    if (STREAM_SAFE && isStreaming) return; // defer while streaming
    const all = getAllTurnNodes();
    const desired = expanded ? all.length : Math.min(visibleCount, all.length);
    const visibleNodes = all.slice(all.length - desired);

    const tasks = [];
    if (wantTokensVisible) tasks.push(cb => sumTokensForNodes(visibleNodes, v => { lastTokens.visible = v; cb(); }));
    if (wantTokensTotal)   tasks.push(cb => sumTokensForNodes(all,          v => { lastTokens.total   = v; cb(); }));

    wantTokensVisible = wantTokensTotal = false;

    (function run(i) {
      if (i >= tasks.length) { updateButton(); return; }
      tasks[i](() => setTimeout(() => run(i + 1), 0));
    })(0);
  }

  function badgeText() {
    const need = expanded ? 'total' : 'visible';
    const val = lastTokens[need];
    return `[T:// ${formatTokens(val)}]`;
  }

  function updateButton(totalCached) {
    ensureButton();
    const b = document.getElementById(BTN_ID);
    if (!b) return;
    const total = (typeof totalCached === 'number') ? totalCached : getTotalTurns();
    const desired = expanded ? total : Math.min(visibleCount, total);
    const hidden = Math.max(0, total - desired);

    const badge = badgeText();

    b.textContent = expanded
      ? `Show only last ${BATCH} ${badge}`
      : (hidden > 0 ? `Show ${hidden} older ${badge}` : `Hide older (none) ${badge}`);
  }

  function clearMarksAll() {
    document.querySelectorAll('.lazy-turn-hidden, .lazy-turn-cv')
      .forEach(el => el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv'));
  }

  // ====== Scroll / anchor ======
  function findScrollableAncestor(node) {
    let el = node && node.parentElement;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return null;
  }

  function resolveScrollContainer() {
    const turns = getTurns();
    const probe = turns.length ? turns[turns.length - 1] : document.body;
    const newContainer = findScrollableAncestor(probe);
    if (newContainer !== scrollContainer) {
      try { if (scrollAttachedTo) scrollAttachedTo.removeEventListener('scroll', onScroll); } catch {}
      try { window.removeEventListener('scroll', onScroll); } catch {}
      scrollContainer = newContainer;
      const target = scrollContainer || window;
      target.addEventListener('scroll', onScroll, { passive: true });
      scrollAttachedTo = scrollContainer || null;
    }
  }

  function viewportTop() { return scrollContainer ? scrollContainer.getBoundingClientRect().top : 0; }
  function getScrollTop() { return scrollContainer ? scrollContainer.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0); }
  function getScrollHeight() { return scrollContainer ? scrollContainer.scrollHeight : (document.scrollingElement || document.documentElement || document.body).scrollHeight; }
  function scrollByDelta(dy) { if (!dy) return; if (!scrollContainer) window.scrollBy({ top: dy, left: 0, behavior: 'auto' }); else scrollContainer.scrollTop += dy; }
  function scrollToBottom() { const h = getScrollHeight(); if (!scrollContainer) window.scrollTo({ top: h, behavior: 'auto' }); else scrollContainer.scrollTop = h; }

  function findAnchorElement() {
    const vt = viewportTop();
    const turns = getTurns();
    for (const el of turns) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vt + 1) return el;
    }
    return turns[0] || null;
  }

  function withAnchor(preserve, action) {
    if (!preserve) { action(); return; }
    resolveScrollContainer();
    const vt = viewportTop();
    const anchor = findAnchorElement();
    const baseTop = anchor ? (anchor.getBoundingClientRect().top - vt) : null;
    action();
    if (anchor && anchor.isConnected && baseTop != null) {
      const newTop = anchor.getBoundingClientRect().top - vt;
      const dy = newTop - baseTop;
      if (dy) scrollByDelta(dy * -1);
    }
  }

  // ====== Detach helpers ======
  function restoreSome(count) {
    if (!count) return;
    const start = Math.max(0, hiddenStore.length - count);
    const batch = hiddenStore.slice(start);
    hiddenStore.length = start;
    batch.forEach(({ placeholder, node }) => {
      if (placeholder && placeholder.isConnected) placeholder.replaceWith(node);
    });
  }

  function detachFirstN(turns, n) {
    if (n <= 0) return 0;
    const limit = Math.min(n, MAX_DETACH_PER_TICK);
    for (let i = 0; i < limit && i < turns.length; i++) {
      const el = turns[i];
      const ph = document.createComment('lazy-detached');
      if (el && el.parentNode) {
        el.parentNode.insertBefore(ph, el);
        el.remove();
        hiddenStore.push({ placeholder: ph, node: el });
      }
    }
    return limit;
  }

  // ====== Streaming: soft folding (chunked) ======
  function softFoldDuringStream() {
    if (!STREAM_SAFE || !isStreaming) return;

    const turns = getTurns();
    const total = turns.length + hiddenStore.length;
    const desired = expanded ? total : Math.min(visibleCount, total);
    const cutoff  = Math.max(0, turns.length - desired); // fold the head
    const cleanLo = Math.max(0, turns.length - desired); // clean visible tail

    // Clean visible tail
    for (let i = cleanLo; i < turns.length; i++) {
      const el = turns[i];
      if (!el) continue;
      if (el.classList.contains('lazy-turn-hidden') || el.classList.contains('lazy-turn-cv')) {
        el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv');
      }
    }

    // Fold head in chunks
    let idx = 0;
    (function step() {
      if (!isStreaming || !STREAM_SAFE) return;
      const end = Math.min(idx + STREAM_SOFT_CHUNK, cutoff);
      for (let i = idx; i < end; i++) {
        const el = turns[i];
        if (!el) continue;
        if (el.classList.contains('lazy-turn-hidden')) el.classList.remove('lazy-turn-hidden');
        if (!el.classList.contains('lazy-turn-cv')) el.classList.add('lazy-turn-cv');
      }
      idx = end;
      if (idx < cutoff) setTimeout(step, 0);
    })();
  }

  function scheduleSoftFoldDuringStream() {
    if (!STREAM_SAFE || !isStreaming || softJobScheduled) return;
    softJobScheduled = true;
    setTimeout(() => { softJobScheduled = false; softFoldDuringStream(); }, 100);
  }

  // ====== Main logic (non-stream phase) ======
  function apply({ preserveAnchor = false, force = false } = {}) {
    resolveScrollContainer();

    const turnsNow = getTurns();
    const total = turnsNow.length + hiddenStore.length;
    const desired = expanded ? total : Math.min(visibleCount, total);

    if (!force &&
        lastMetrics.total === total &&
        lastMetrics.desiredVisible === desired &&
        lastMetrics.mode === MODE &&
        lastMetrics.expanded === expanded) {
      updateButton(total);
      return;
    }

    if (expanded) {
      withAnchor(false, () => {
        if (MODE === 'detach' && hiddenStore.length) restoreSome(hiddenStore.length);
        clearMarksAll();
      });
      lastMetrics = { total, desiredVisible: desired, mode: MODE, expanded };
      updateButton(total);
      scheduleTokens('total'); // recompute tokens for total
      return;
    }

    if (MODE === 'detach') {
      withAnchor(preserveAnchor, () => {
        const currentHidden = hiddenStore.length;
        const targetHidden  = total - desired;

        if (currentHidden > targetHidden) {
          restoreSome(currentHidden - targetHidden);
        }

        const afterRestoreVisible = getTurns().length;
        const needDetach = Math.max(0, afterRestoreVisible - desired);
        if (needDetach > 0) {
          const did = detachFirstN(getTurns(), needDetach);
          if (needDetach > did) setTimeout(() => apply({ preserveAnchor: true, force: true }), 0);
        }
      });

    } else {
      withAnchor(preserveAnchor, () => {
        const turns = getTurns();
        const cutoff = Math.max(0, turns.length - desired);

        for (let i = turns.length - desired; i < turns.length; i++) {
          const el = turns[i];
          if (!el) continue;
          if (el.classList.contains('lazy-turn-hidden') || el.classList.contains('lazy-turn-cv')) {
            el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv');
          }
        }
        for (let i = 0; i < cutoff; i++) {
          const el = turns[i];
          if (!el) continue;
          if (MODE === 'hide') {
            if (!el.classList.contains('lazy-turn-hidden')) el.classList.add('lazy-turn-hidden');
          } else if (MODE === 'cv') {
            if (!el.classList.contains('lazy-turn-cv')) el.classList.add('lazy-turn-cv');
          }
        }
      });
    }

    lastMetrics = { total, desiredVisible: desired, mode: MODE, expanded };
    updateButton(total);
    scheduleTokens('visible'); // recompute tokens for visible part
  }

  // ====== Upward infinite reveal ======
  function revealMoreUp() {
    if (expanded) return;
    const total = getTotalTurns();
    const desired = Math.min(visibleCount + BATCH, total);
    if (desired === visibleCount || isRevealing) return;

    isRevealing = true;
    visibleCount = desired;

    if (STREAM_SAFE && isStreaming) {
      scheduleSoftFoldDuringStream(); // soft only — skip heavy apply()
      scheduleTokens('visible');      // recalc tokens after streaming finishes
    } else {
      apply({ preserveAnchor: true, force: true });
    }
    requestAnimationFrame(() => { isRevealing = false; });
  }

  function onScroll() {
    if (expanded) return;
    if (getScrollTop() <= TOP_REVEAL_THRESHOLD) revealMoreUp();
  }

  // ====== Toggle ======
  function toggle() {
    expanded = !expanded;
    if (expanded && (STREAM_SAFE && isStreaming)) {
      // Expand visually even during stream: just remove marks
      clearMarksAll();
      updateButton(); scheduleTokens('total');
    } else {
      if (!expanded) {
        visibleCount = BATCH;
        requestAnimationFrame(scrollToBottom);
      }
      apply({ preserveAnchor: false, force: true });
    }
  }

  // ====== URL change reset ======
  function resetForNewChat() {
    // Drop any marks in current DOM (just in case)
    clearMarksAll();

    // Reset core state
    expanded = false;
    visibleCount = BATCH;
    isRevealing = false;

    // Detach/archive store — forget old nodes
    hiddenStore.length = 0;

    // Scroll container will be resolved on next apply
    scrollContainer = null;
    scrollAttachedTo = null;

    // Reset metrics so apply() definitely runs
    lastMetrics = { total: -1, desiredVisible: -1, mode: MODE, expanded };

    // Streaming flags/timers
    isStreaming = false;
    if (streamFlipTimer) { clearTimeout(streamFlipTimer); streamFlipTimer = null; }
    softJobScheduled = false;

    // Tokens: clear cache & last values
    tokenCache = new WeakMap();
    lastTokens.visible = null;
    lastTokens.total = null;
    wantTokensVisible = false;
    wantTokensTotal = false;
    tokenJobQueued = false;

    // Re-attach observer to the new feed root
    attachObserver(pickFeedRoot());

    // Apply fresh collapsed view and recalc visible tokens
    apply({ preserveAnchor: false, force: true });
    scheduleTokens('visible');

    // Scroll to the bottom of the new chat
    requestAnimationFrame(scrollToBottom);
  }

  // ====== Observe & boot ======
  function recomputeStreamingFlag() {
    const hard = hasStopButton();
    if (hard) {
      if (!isStreaming) { isStreaming = true; scheduleSoftFoldDuringStream(); }
      if (streamFlipTimer) { clearTimeout(streamFlipTimer); streamFlipTimer = null; }
      return;
    }
    if (isStreaming && !streamFlipTimer) {
      streamFlipTimer = setTimeout(() => {
        isStreaming = false;
        streamFlipTimer = null;
        // After streaming ends — run full pass and token recompute
        apply({ preserveAnchor: true, force: true });
        scheduleTokens('both');
      }, STREAM_OFF_COOLDOWN);
    }
  }

  function attachObserver(root) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(
      debounce(() => {
        // Update streaming flag via Stop button presence
        recomputeStreamingFlag();

        if (STREAM_SAFE && isStreaming) {
          // During stream — no heavy work
          scheduleSoftFoldDuringStream();
          updateButton();
          return;
        }
        apply({ preserveAnchor: false });
      }, OBS_DEBOUNCE_MS)
    );
    try {
      observer.observe(root, { childList: true, subtree: true });
      observerRoot = root;
    } catch {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      observerRoot = document.documentElement;
    }
  }

  function pickFeedRoot() {
    return document.querySelector('[role="feed"]') ||
           document.querySelector('main [role="feed"]') ||
           document.querySelector('main') ||
           document.body ||
           document.documentElement;
  }

  function boot() {
    ensureStyle();
    ensureButton();

    attachObserver(pickFeedRoot());

    // Initial fold
    apply({ preserveAnchor: false, force: true });
    scheduleTokens('visible');

    // Periodic Stop-button polling (cheap & robust)
    setInterval(recomputeStreamingFlag, 300);

    // SPA/pending init poll + URL change detection
    let tries = 80;
    const poll = setInterval(() => {
      // Detect URL change (SPA navigation) and reset all state
      if (location.href !== lastURL) {
        lastURL = location.href;
        resetForNewChat();
        // fresh boot for the new chat, skip the rest of this tick
        return;
      }

      const root = pickFeedRoot();
      if (root && root !== observerRoot) attachObserver(root);
      recomputeStreamingFlag();
      if (!isStreaming) apply({ preserveAnchor: false });
      if (getTurns().length > 0 || --tries <= 0) clearInterval(poll);
    }, 250);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
})();
