// ==UserScript==
// @name         ChatGPT Lazy Chat++ (stream-safe + tokens badge)
// @namespace    chatgpt-lazy
// @version      1.0.3
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
 */

(function () {
  'use strict';

  // ====== Settings ======
  const MODE = 'detach';            // 'hide' | 'detach' | 'cv'
  const BATCH = 8;
  const OBS_DEBOUNCE_MS = 250;
  const TOP_REVEAL_THRESHOLD = 120;
  const BTN_ID = 'cgpt-lazy-btn';

  // Stream-safety & chunking
  const STREAM_SAFE = true;
  const STREAM_OFF_COOLDOWN = 500;
  const MAX_DETACH_PER_TICK = 50;
  const STREAM_SOFT_CHUNK   = 40;

  // Full navigation policy on any in-domain URL change
  const FORCE_FULL_NAV = true;
  const RELOAD_GUARD_KEY = 'cgpt-lazy-fullnav';
  const RELOAD_GUARD_MS  = 5000; // guard against loops for the same URL

  // Turn containers
  const TURN_SELECTOR = [
    '[data-testid^="conversation-turn"]',
    'article[data-turn-id]',
    'article[data-turn]',
    'div[data-testid^="conversation-turn"]',
    'li[data-testid^="conversation-turn"]'
  ].join(',');

  // Streaming flag
  const STOP_BTN_SEL =
    '#composer-submit-button[data-testid="stop-button"],' +
    '[data-testid="stop-button"],' +
    'button[aria-label*="stop streaming" i]';

  // ====== State ======
  let expanded = false;
  let visibleCount = BATCH;
  let hiddenStore = [];
  let observer = null;
  let observerRoot = null;
  let isRevealing = false;

  // Scroll
  let scrollContainer = null;
  let scrollAttachedTo = null;

  // Metrics
  let lastMetrics = { total: -1, desiredVisible: -1, mode: MODE, expanded };

  // Streaming
  let isStreaming = false;
  let streamFlipTimer = null;
  let softJobScheduled = false;

  // URL tracking (fallback watcher still present)
  let lastURL = location.href;

  // Initial stabilization (used if full-nav is guarded/disabled)
  let isInitializing = false;
  const STABLE_CHECK_INTERVAL = 200;
  const STABLE_REQUIRED_MS    = 600;
  const INIT_TIMEOUT_MS       = 5000;

  // Token estimator (≈ 1.3 × spaces)
  const TOKEN_RATIO = 1.3;
  const TOKENS_PER_TICK = 20;
  let tokenCache = new WeakMap();
  const lastTokens = { visible: null, total: null };
  let wantTokensVisible = false, wantTokensTotal = false, tokenJobQueued = false;

  // ====== Utils ======
  const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function pickActiveFeedRoot() {
    // Pick the largest visible [role=feed]; ignores hidden stale feeds left by SPA routing.
    const cands = Array.from(document.querySelectorAll('[role="feed"]'));
    let best = null, bestArea = -1;
    for (const el of cands) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width) * Math.max(1, r.height);
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (best) return best;
    return document.querySelector('main [role="feed"]')
        || document.querySelector('main')
        || document.body
        || document.documentElement;
  }

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

  function queryInRoot(selector) {
    const root = observerRoot || pickActiveFeedRoot() || document;
    return Array.from(root.querySelectorAll(selector));
  }

  const getTurns = () => queryInRoot(TURN_SELECTOR);
  const getAllTurnNodes = () => hiddenStore.length ? hiddenStore.map(h => h.node).concat(getTurns()) : getTurns();
  const getTotalTurns = () => getTurns().length + hiddenStore.length;

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

  function scheduleTokens(kind) {
    if (kind === 'visible' || kind === 'both') wantTokensVisible = true;
    if (kind === 'total'   || kind === 'both') wantTokensTotal   = true;
    if (tokenJobQueued) return;
    tokenJobQueued = true;
    setTimeout(runTokenJob, 0);
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

  function runTokenJob() {
    tokenJobQueued = false;
    if (STREAM_SAFE && isStreaming) return;
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
    queryInRoot('.lazy-turn-hidden, .lazy-turn-cv')
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
    const probe = turns.length ? turns[turns.length - 1] : (observerRoot || document.body);
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

  const viewportTop = () => (scrollContainer ? scrollContainer.getBoundingClientRect().top : 0);
  const getScrollTop = () => (scrollContainer ? scrollContainer.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0));
  const getScrollHeight = () => (scrollContainer ? scrollContainer.scrollHeight : (document.scrollingElement || document.documentElement || document.body).scrollHeight);
  const scrollByDelta = (dy) => { if (!dy) return; if (!scrollContainer) window.scrollBy({ top: dy, left: 0, behavior: 'auto' }); else scrollContainer.scrollTop += dy; };
  const scrollToBottom = () => { const h = getScrollHeight(); if (!scrollContainer) window.scrollTo({ top: h, behavior: 'auto' }); else scrollContainer.scrollTop = h; };

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

  // ====== Streaming helpers ======
  const hasStopButtonVisible = () =>
    Array.from(document.querySelectorAll(STOP_BTN_SEL)).some(isVisible);

  function softFoldDuringStream() {
    if (!STREAM_SAFE || !isStreaming) return;

    const turns = getTurns();
    const total = turns.length + hiddenStore.length;
    const desired = expanded ? total : Math.min(visibleCount, total);
    const cutoff  = Math.max(0, turns.length - desired);
    const cleanLo = Math.max(0, turns.length - desired);

    for (let i = cleanLo; i < turns.length; i++) {
      const el = turns[i];
      if (!el) continue;
      if (el.classList.contains('lazy-turn-hidden') || el.classList.contains('lazy-turn-cv')) {
        el.classList.remove('lazy-turn-hidden', 'lazy-turn-cv');
      }
    }

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

  // ====== Main logic ======
  function apply({ preserveAnchor = false, force = false } = {}) {
    if (isInitializing) { updateButton(); return; }

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
      scheduleTokens('total');
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
    scheduleTokens('visible');
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
      scheduleSoftFoldDuringStream();
      scheduleTokens('visible');
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

  // ====== Force full navigation on in-domain URL changes ======
  function shouldForceNav(toURL) {
    try {
      const cur = new URL(location.href);
      const next = new URL(toURL, location.href);
      if (cur.origin !== next.origin) return false;     // external domain: let browser handle it
      // Ignore pure hash changes
      const sameExceptHash =
        cur.origin === next.origin &&
        cur.pathname === next.pathname &&
        cur.search   === next.search   &&
        cur.hash     !== next.hash;
      if (sameExceptHash) return false;
      return true;
    } catch { return false; }
  }

  function guardAndAssign(href) {
    try {
      const now = Date.now();
      const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
      const info = raw ? JSON.parse(raw) : null;
      if (!info || info.url !== href || (now - info.ts) > RELOAD_GUARD_MS) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ url: href, ts: now }));
        window.location.assign(href); // full navigation (not SPA)
      }
    } catch {
      window.location.assign(href);
    }
  }

  // Intercept clicks on any in-domain <a href="..."> and force full navigation,
  // EXCEPT when the click originated from a <button> inside that <a>
  // (folder toggle icon, "More" triple-dot, etc.).
  document.addEventListener('click', (e) => {
    if (!FORCE_FULL_NAV) return;
    const isPrimary = (e.button === 0);
    const modifiers = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    if (!isPrimary || modifiers || e.defaultPrevented) return;

    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;

    // Do not hijack clicks that are meant for local controls inside the row
    // (folder open/close button, three-dots menu, etc.)
    const innerButton = e.target.closest('button');
    if (innerButton && a.contains(innerButton)) return;

    if (a.target && a.target.toLowerCase() === '_blank') return;
    if (a.hasAttribute('download')) return;

    const href = a.getAttribute('href');
    const url = new URL(href, location.href);
    if (!shouldForceNav(url.href)) return;

    e.preventDefault();
    guardAndAssign(url.href);
  }, true);

  // If SPA code calls history.pushState / replaceState, force full navigation instead.
  if (FORCE_FULL_NAV) {
    const wrapHistory = (method) => {
      const orig = history[method];
      history[method] = function (state, title, url) {
        const prev = location.href;
        const ret  = orig.apply(this, arguments);
        try {
          if (url) {
            const next = new URL(url, prev).href;
            if (shouldForceNav(next)) guardAndAssign(next);
          }
        } catch { /* ignore */ }
        return ret;
      };
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');

    window.addEventListener('popstate', () => {
      if (shouldForceNav(location.href)) guardAndAssign(location.href);
    });
  }

  // ====== Fallback soft reset (kept for safety if forcing is disabled/guarded) ======
  function resetForNewChat() {
    clearMarksAll();

    expanded = false;
    visibleCount = BATCH;
    isRevealing = false;

    hiddenStore.length = 0;

    scrollContainer = null;
    scrollAttachedTo = null;

    lastMetrics = { total: -1, desiredVisible: -1, mode: MODE, expanded };

    isStreaming = false;
    if (streamFlipTimer) { clearTimeout(streamFlipTimer); streamFlipTimer = null; }
    softJobScheduled = false;

    tokenCache = new WeakMap();
    lastTokens.visible = null;
    lastTokens.total = null;
    wantTokensVisible = false;
    wantTokensTotal = false;
    tokenJobQueued = false;

    observerRoot = pickActiveFeedRoot();
    attachObserver(observerRoot);

    startInitialStabilization();
  }

  function startInitialStabilization() {
    isInitializing = true;
    let lastLen = -1;
    let stableMs = 0;
    const t0 = Date.now();

    (function tick() {
      observerRoot = pickActiveFeedRoot();
      const len = getTurns().length;

      if (len > 0 && len === lastLen) {
        stableMs += STABLE_CHECK_INTERVAL;
      } else {
        stableMs = 0;
        lastLen = len;
      }

      const timeout = (Date.now() - t0) >= INIT_TIMEOUT_MS;
      if (stableMs >= STABLE_REQUIRED_MS || timeout) {
        isInitializing = false;
        apply({ preserveAnchor: false, force: true });
        scheduleTokens('visible');
        requestAnimationFrame(scrollToBottom);
      } else {
        setTimeout(tick, STABLE_CHECK_INTERVAL);
      }
    })();
  }

  // ====== Observe & boot ======
  function recomputeStreamingFlag() {
    const hard = hasStopButtonVisible();
    if (hard) {
      if (!isStreaming) { isStreaming = true; scheduleSoftFoldDuringStream(); }
      if (streamFlipTimer) { clearTimeout(streamFlipTimer); streamFlipTimer = null; }
      return;
    }
    if (isStreaming && !streamFlipTimer) {
      streamFlipTimer = setTimeout(() => {
        isStreaming = false;
        streamFlipTimer = null;
        apply({ preserveAnchor: true, force: true });
        scheduleTokens('both');
      }, STREAM_OFF_COOLDOWN);
    }
  }

  function attachObserver(root) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(
      debounce(() => {
        recomputeStreamingFlag();

        if (isInitializing) { updateButton(); return; }
        if (STREAM_SAFE && isStreaming) {
          scheduleSoftFoldDuringStream();
          updateButton();
          return;
        }
        apply({ preserveAnchor: false });
      }, OBS_DEBOUNCE_MS)
    );

    try {
      if (!root) root = pickActiveFeedRoot();
      observer.observe(root || document.documentElement, { childList: true, subtree: true });
      observerRoot = root || observerRoot || document.body;
    } catch {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      observerRoot = observerRoot || pickActiveFeedRoot() || document.body;
    }
  }

  function boot() {
    ensureStyle();
    ensureButton();

    observerRoot = pickActiveFeedRoot();
    attachObserver(observerRoot);

    apply({ preserveAnchor: false, force: true });
    scheduleTokens('visible');

    // Streaming polling
    setInterval(recomputeStreamingFlag, 300);

    // Fallback SPA watcher (should rarely be needed now)
    let tries = 80;
    const poll = setInterval(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        if (!FORCE_FULL_NAV) resetForNewChat();
        return;
      }

      const root = pickActiveFeedRoot();
      if (root && root !== observerRoot) { observerRoot = root; attachObserver(root); }
      recomputeStreamingFlag();

      if (!isInitializing && !isStreaming) apply({ preserveAnchor: false });
      if (getTurns().length > 0 || --tries <= 0) clearInterval(poll);
    }, 250);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
})();
