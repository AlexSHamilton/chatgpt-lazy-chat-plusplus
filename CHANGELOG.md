# Changelog
All notable changes to **ChatGPT Lazy Chat++** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2025-09-14

### Fixed
- **Model picker popover:** no longer hijacks clicks; switching the model doesn’t trigger a full-page reload.
- **Occasional wrong “Show X older” counts after chat switch:** full reload is now forced **only** for sidebar chat/project links, ensuring a clean DOM and correct counters.

### Changed
- **Scope of link interception limited to the left sidebar** (`nav[aria-label="Chat history"]`, `#history`, and elements with `w-[var(--sidebar-width)]` in the class list).
- **Safer navigation rules:** ignore external links, hash-only anchors, `target="_blank"`, and clicks with modifier keys (Ctrl/Meta/Shift/Alt).
- **State hygiene:** clear the `lcpp_pending_nav` session flag on page load.

## [1.0.3] - 2025-09-13
### Fixed
- **Folder toggle exception:** do not hijack clicks on `<button>` inside sidebar `<a>` rows (project folder expand/collapse and the “more” triple-dot). Prevents unintended full navigation when user wants to expand a folder.

### Changed
- Minor polish in link interception comments.

## [1.0.2] - 2025-09-13
### Added
- **Force full navigation** for any in-domain link (and History API calls). This eliminates SPA leftovers that caused wrong “Show N older” counts.
- **History API interception:** wrap `pushState`/`replaceState` and handle `popstate` to force a clean page load for in-domain URL changes.
- **Reload guard:** sessionStorage loop guard to avoid double navigations.
  
### Changed
- Ignore pure `#hash` changes (no full reload).
  
### Fixed
- Stable “Show N older” after switching chats; removes need for manual browser reload.

## [1.0.1] - 2025-09-13
### Added
- **Soft reset on URL change** (fallback path): clear marks, reset internal state, recalc tokens, re-attach observer.
- **Active feed root detection:** choose the largest visible `[role="feed"]` to avoid counting stale hidden feeds left by the SPA.
- **Initialization stabilizer:** short settling period (stable length check) before first fold to avoid off-by-many counts.

### Fixed
- Intermittent miscount of “older” turns immediately after switching chats.

## [1.0.0] - 2025-09-13
### Added
- Initial public release.  
- **Modes:** `hide | detach | cv`.  
- **Smooth infinite scroll up** (batch = 8).  
- **Stream-safe**: avoids heavy DOM ops while the model is generating; soft folding during stream.  
- **Anchor-preserving folding** (no jumps).  
- **Toggle button** (collapse ↔ show all).  
- **Token badge** on the button: `[T:// …]` — estimated tokens in view (≈ 1.3 × spaces), switches to total in expanded mode.

---
