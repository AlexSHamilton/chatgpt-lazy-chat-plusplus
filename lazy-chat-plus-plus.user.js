// ==UserScript==
// @name         ChatGPT Lazy Chat++ (HARD PAUSE + idle batching)
// @namespace    chatgpt-lazy
// @version      1.0.9
// @description  Keeps only the last N chat turns visible with smooth upward reveal. HARD PAUSE during streaming (no DOM work at all). Idle-batched apply. Tokens recompute only post-stream & on reveal/toggle. Modes: hide | detach | cv. Button shows estimated tokens as [T:// …] (≈1.3 × spaces).
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
 */

// Normal Copy on ChatGPT

(function () {
  const forceNormalCopy = (e) => {
    e.stopImmediatePropagation();
    return true;
  };

  ['copy', 'cut'].forEach(event => {
    document.addEventListener(event, forceNormalCopy, true);
  });
})();


(function () {
  'use strict';

  // =========================
  // Settings
  // =========================
  const MODE = 'detach';            // 'hide' | 'detach' | 'cv'
  const BATCH = 8;                  // upward auto-reveal batch size
  const OBS_DEBOUNCE_MS = 250;
  const TOP_REVEAL_THRESHOLD = 120; // px from top to trigger reveal
  const BTN_ID = 'cgpt-lazy-btn';

  // Stream-safety
  // HARD PAUSE: while Stop button is visible -> absolutely no DOM work.
  // Only a lightweight poll of the Stop-button state every HARD_POLL_MS.
  const STREAM_SAFE = true;
  const HARD_PAUSE = true;
  const HARD_POLL_MS = 500;          // Stop-button polling interval
  const STREAM_OFF_COOLDOWN = 500;   // cooldown after stop disappears before recompute

  // Anti-freeze chunking (kept for non-streaming ops)
  const MAX_DETACH_PER_TICK = 50;

  // Turn nodes
  const TURN_SELECTOR = [
    '[data-testid^="conversation-turn"]',
    'article[data-turn-id]',
    'article[data-turn]',
    'div[data-testid^="conversation-turn"]',
    'li[data-testid^="conversation-turn"]'
  ].join(',');

  // Streaming flag — “Stop streaming” button
  const STOP_BTN_SEL =
    '#composer-submit-button[data-testid="stop-button"],' +
    '[data-testid="stop-button"],' +
    'button[aria-label*="stop streaming" i]';

  // =========================
  // State
  // =========================
  let expanded = false;
  let visibleCount = BATCH;
  let hiddenStore = [];            // detach store: [{ placeholder, node }]
  let observer = null;
  let observerRoot = null;
  let isRevealing = false;

  // Scroll
  let scrollContainer = null;
  let scrollAttachedTo = null;

  // Metrics cache for apply()
  let lastMetrics = { total: -1, desiredVisible: -1, mode: MODE, expanded };

  // Streaming state
  let isStreaming = false;
  let streamFlipTimer = null;

  // Idle batching for apply()
  let applyIdleHandle = null;
  let applyTimeoutHandle = null;
  let pendingApply = null; // {preserveAnchor, force, tokenHint}
  // TokenHint semantics: null=no token work; 'visible'|'total'|'both'
  function mergeTokenHints(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    if (a === 'both' || b === 'both') return 'both';
    if ((a === 'visible' && b === 'total') || (a === 'total' && b === 'visible')) return 'both';
    return a; // same kind
  }

  // =========================
  // Token estimator (≈1.3×spaces)
  // =========================
  const TOKEN_RATIO = 1.3;
  const TOKENS_PER_TICK = 20;
  const tokenCache = new WeakMap(); // WeakMap<Node, {tokens:number, dirty?:boolean}>
  const lastTokens = { visible: null, total: null };
  let tokenJobQueued = false;

  // =========================
  // Utils
  // =========================
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
    b.addEventListener('click', () => {
      // Block accidental toggles while streaming under HARD PAUSE.
      if (HARD_PAUSE && isStreaming) return;
      toggle();
    });
    document.body.appendChild(b);
  }

  function updateButton(totalCached) {
    // Under HARD PAUSE we avoid any DOM updates during streaming.
    if (HARD_PAUSE && isStreaming) return;
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

  function getTurns() { return Array.from(document.querySelectorAll(TURN_SELECTOR)); }
  function getAllTurnNodes() { return hiddenStore.length ? hiddenStore.map(h => h.node).concat(getTurns()) : getTurns(); }
  function getTotalTurns() { return getTurns().length + hiddenStore.length; }

  // ----- tokens -----
  function formatTokens(n) {
    if (n == null) return '…';
    if (n >= 1e6)  return (n / 1e6).toFixed(n % 1e6 >= 1e5 ? 1 : 0) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(n % 1e3 >= 100 ? 1 : 0) + 'k';
    return String(n);
  }
  function countSpaces(text) {
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

  // tokens: recalc only when explicitly hinted (post-stream, reveal, toggle, initial boot)
  function scheduleTokens(kind) {
    if (tokenJobQueued) return;
    tokenJobQueued = true;
    setTimeout(() => runTokenJob(kind), 50); // light throttle to avoid typing spikes
  }
  function runTokenJob(kind) {
    tokenJobQueued = false;
    // HARD PAUSE: no token work while streaming.
    if ((STREAM_SAFE || HARD_PAUSE) && isStreaming) return;

    const all = getAllTurnNodes();
    const desired = expanded ? all.length : Math.min(visibleCount, all.length);
    const visibleNodes = all.slice(all.length - desired);

    const needVisible = (kind === 'visible' || kind === 'both' || (kind == null && !expanded));
    const needTotal   = (kind === 'total'   || kind === 'both' || (kind == null && expanded));

    const tasks = [];
    if (needVisible) tasks.push(cb => sumTokensForNodes(visibleNodes, v => { lastTokens.visible = v; cb(); }));
    if (needTotal)   tasks.push(cb => sumTokensForNodes(all,          v => { lastTokens.total   = v; cb(); }));

    if (!tasks.length) { updateButton(); return; }

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

  // ----- scroll/anchor -----
  function clearMarksAll() {
    document.querySelectorAll('.lazy-turn-hidden, .lazy-turn-cv')
      .forEach(el => el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv'));
  }
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

  // ----- detach helpers -----
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

  // ----- main apply (non-stream) -----
  function apply({ preserveAnchor = false, force = false, tokenHint = null } = {}) {
    // HARD PAUSE: don't touch DOM while streaming.
    if (HARD_PAUSE && isStreaming) return;

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
      if (tokenHint) scheduleTokens(tokenHint);
      return;
    }

    if (expanded) {
      withAnchor(false, () => {
        if (MODE === 'detach' && hiddenStore.length) restoreSome(hiddenStore.length);
        clearMarksAll();
      });
      lastMetrics = { total, desiredVisible: desired, mode: MODE, expanded };
      updateButton(total);
      if (tokenHint) scheduleTokens(tokenHint);
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
          if (needDetach > did) scheduleApply({ preserveAnchor: true, force: true, tokenHint });
        }
      });

    } else {
      withAnchor(preserveAnchor, () => {
        const turns = getTurns();
        const cutoff = Math.max(0, turns.length - desired);

        for (let i = turns.length - desired; i < turns.length; i++) {
          const el = turns[i];
          if (!el) continue;
          el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv');
        }
        for (let i = 0; i < cutoff; i++) {
          const el = turns[i];
          if (!el) continue;
          if (MODE === 'hide') el.classList.add('lazy-turn-hidden');
          else if (MODE === 'cv') el.classList.add('lazy-turn-cv');
        }
      });
    }

    lastMetrics = { total, desiredVisible: desired, mode: MODE, expanded };
    updateButton(total);
    if (tokenHint) scheduleTokens(tokenHint);
  }

  // ----- idle-batched scheduler for apply() -----
  function scheduleApply(opts) {
    if (HARD_PAUSE && isStreaming) return;
    // merge options with pending
    if (!pendingApply) pendingApply = { preserveAnchor: false, force: false, tokenHint: null };
    pendingApply.preserveAnchor = pendingApply.preserveAnchor || !!opts.preserveAnchor;
    pendingApply.force = pendingApply.force || !!opts.force;
    pendingApply.tokenHint = mergeTokenHints(pendingApply.tokenHint, opts.tokenHint || null);

    // already scheduled
    if (applyIdleHandle || applyTimeoutHandle) return;

    const run = () => {
      applyIdleHandle = null;
      applyTimeoutHandle = null;
      const payload = pendingApply; pendingApply = null;
      apply(payload || {});
    };

    // prefer idle callback with a timeout fallback to avoid starvation
    if ('requestIdleCallback' in window) {
      try {
        applyIdleHandle = requestIdleCallback(run, { timeout: 80 });
      } catch {
        applyTimeoutHandle = setTimeout(run, 50);
      }
    } else {
      applyTimeoutHandle = setTimeout(run, 50);
    }
  }

  // ----- infinite reveal up -----
  function revealMoreUp() {
    if (expanded) return;
    if (HARD_PAUSE && isStreaming) return; // block reveals during streaming

    const total = getTotalTurns();
    const desired = Math.min(visibleCount + BATCH, total);
    if (desired === visibleCount || isRevealing) return;

    isRevealing = true;
    visibleCount = desired;

    scheduleApply({ preserveAnchor: true, force: true, tokenHint: 'visible' });
    requestAnimationFrame(() => { isRevealing = false; });
  }
  function onScroll() {
    if (expanded) return;
    if (getScrollTop() <= TOP_REVEAL_THRESHOLD) revealMoreUp();
  }

  // ----- toggle -----
  function toggle() {
    if (HARD_PAUSE && isStreaming) return; // block toggles during streaming

    expanded = !expanded;
    if (!expanded) {
      visibleCount = BATCH;
      requestAnimationFrame(scrollToBottom);
      scheduleApply({ preserveAnchor: false, force: true, tokenHint: 'visible' });
    } else {
      scheduleApply({ preserveAnchor: false, force: true, tokenHint: 'total' });
    }
  }

  // =========================
  // Streaming detection (HARD PAUSE)
  // =========================
  function recomputeStreamingFlag() {
    // Only reads Stop-button presence; MUST NOT mutate DOM.
    const hard = hasStopButton();

    if (hard) {
      if (!isStreaming) {
        isStreaming = true; // enter HARD PAUSE; do nothing else.
      }
      if (streamFlipTimer) { clearTimeout(streamFlipTimer); streamFlipTimer = null; }
      return;
    }

    // Stop-button gone -> schedule one-shot full recompute after cooldown.
    if (isStreaming && !streamFlipTimer) {
      streamFlipTimer = setTimeout(() => {
        isStreaming = false;
        streamFlipTimer = null;
        // One full recompute after stream ends.
        scheduleApply({ preserveAnchor: true, force: true, tokenHint: 'both' });
      }, STREAM_OFF_COOLDOWN);
    }
  }

  function attachObserver(root) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(
      debounce(() => {
        // HARD PAUSE: ignore all mutations while streaming.
        if (HARD_PAUSE && isStreaming) return;
        // Batch mutations via idle scheduler; no token work from generic mutations.
        scheduleApply({ preserveAnchor: false, force: false });
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

  // =========================
  // FULL reload only for sidebar links (fix model picker)
  // =========================
  const SIDEBAR_SCOPE_SEL = 'nav[aria-label="Chat history"], #history, [class*="sidebar-width"]';

  function isInsideSidebar(node) {
    return !!(node && node.closest(SIDEBAR_SCOPE_SEL));
  }

  function isInternalHref(href) {
    if (!href) return false;
    if (/^(mailto:|javascript:|data:)/i.test(href)) return false;
    if (href.startsWith('#')) return false;
    if (href.startsWith('/')) return true;
    try { return new URL(href, location.origin).origin === location.origin; }
    catch { return false; }
  }

  // Treat any interactive control inside the row (folder chevron, kebab menu, etc.) as "hands off".
  function isInteractiveBeforeAnchor(target, anchor) {
    let el = target;
    while (el && el !== anchor) {
      if (el.matches('button, [role="button"], summary, input, select, textarea, label, [aria-expanded], [aria-haspopup], [data-trailing-button], .__menu-item-trailing-btn, [data-testid*="toggle"], [data-testid*="menu"], [data-testid*="trailing"]')) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // Single source of truth: force navigation only if click happened in the sidebar scope and was not on an inner interactive control.
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    const t = ev.target;
    const link = t && t.closest && t.closest('a[href]');
    if (!link) return;

    // Restrict to left sidebar only.
    if (!isInsideSidebar(t)) return;

    // If the click is on/inside an interactive control (folder toggle chevron, kebab menu, etc.), let default behavior proceed.
    if (isInteractiveBeforeAnchor(t, link)) return;

    const href = link.getAttribute('href');
    if (!isInternalHref(href)) return;
    if (link.target === '_blank') return;

    // Force full-page reload to avoid SPA leftovers.
    try { sessionStorage.setItem('lcpp_pending_nav', '1'); } catch {}
    ev.preventDefault();
    location.assign(href);
  }, true);

  // Cleanup pending flag on load (best-effort).
  try { sessionStorage.removeItem('lcpp_pending_nav'); } catch {}

  // =========================
  // Boot
  // =========================
  function boot() {
    ensureStyle();
    ensureButton();

    attachObserver(pickFeedRoot());

    // initial fold + initial tokens for visible portion
    apply({ preserveAnchor: false, force: true, tokenHint: 'visible' });

    // HARD PAUSE: lightweight poll of Stop-button every HARD_POLL_MS
    setInterval(recomputeStreamingFlag, HARD_POLL_MS);

    // SPA init poll (kept small): attach observer when feed node changes.
    // Do not query Stop-button here to honor the single polling source above.
    let tries = 80;
    const poll = setInterval(() => {
      const root = pickFeedRoot();
      if (root && root !== observerRoot) attachObserver(root);
      // Only schedule lightweight, no-token apply outside streaming
      if (!isStreaming) scheduleApply({ preserveAnchor: false });
      if (getTurns().length > 0 || --tries <= 0) clearInterval(poll);
    }, 250);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
})();
