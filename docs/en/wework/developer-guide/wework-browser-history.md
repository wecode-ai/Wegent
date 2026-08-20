---
sidebar_position: 47
---

# Wework Embedded Browser History — Technical Design

> Reference design: [Codex built-in browser history analysis](./codex-browser-history-analysis.md). UI and interactions mirror Codex.
> Entry points: the browser toolbar "more" menu, and Settings → Browser → General.

## Goals and Scope

### In scope

1. **Entry 1**: add a "History" item to the browser toolbar "more" (`...`) menu, placed above "Clear browsing data"; it opens the history list page.
2. **Entry 2**: add a "Browsing history" row to Settings → Browser → General (label + description + a "Manage" button on the right); it opens the history list page.
3. **History list page**: search, collapsible day groups, per-entry open/delete, multi-select bulk delete, infinite scroll, and a clear-browsing-data entry — all matching Codex behavior and copy.
4. **Data layer**: record navigation history on the Rust side with persistence, expose search/remove IPC, and wipe history together with clear browsing data.

### Out of scope (future iterations)

- A time-range × data-type clear browsing data dialog (Wework currently has a single full-clear dialog; this design only folds history into its scope).
- Chrome profile import, an AI history-access approval setting, and address-bar history suggestions.
- Recording SPA `pushState` navigations (not covered by WRY `on_navigation`; see "Known limitations").

## Entry Design

### Entry 1: browser toolbar more menu

In the `ActionMenu` (`workspace-browser-more-button`) of [WorkspaceBrowserPanel.tsx](../../../../wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx), insert **before** `workspace-browser-clear-data-item`:

```ts
{
  label: t('workbench.browser_history'),
  testId: 'workspace-browser-history-item',
  onSelect: () => navigateTo('/settings/browser/history'),
},
```

The item has no disabled condition (the whole menu is already hidden when the embedded browser is unavailable).

### Entry 2: Settings → Browser → General row

In the "General" `SettingsGroup` of [BrowserSettingsPage.tsx](../../../../wework/src/components/settings/BrowserSettingsPage.tsx), add a `SettingsRow` **before** the clear-data row:

- label: `workbench.browser_settings_history` ("Browsing history")
- description: `workbench.browser_settings_history_description` ("View and manage pages visited in the built-in browser")
- control: secondary button style (same as the clear-data button, `h-8 rounded-md bg-muted px-3`), label `workbench.browser_settings_history_manage` ("Manage"), `data-testid="browser-history-manage-button"`, `disabled={controlsDisabled}`, `onClick` → `navigateTo('/settings/browser/history')`.

### Routing

Wework settings are a single-page app keyed by nav items ([ConnectionsSettingsPage.tsx](../../../../wework/src/components/settings/ConnectionsSettingsPage.tsx)); `getSettingsNavFromPath` currently only matches single-segment `/settings/<key>` paths. Plan:

- Extend `getSettingsNavFromPath`: `/settings/browser/history` → activeNav `'browser'`.
- `BrowserSettingsPage` keeps internal sub-view state: render `BrowserHistoryPage` when `location.pathname` is `/settings/browser/history`, otherwise the existing content. The history page's back button and the "Browser" breadcrumb item call `navigateTo('/settings/browser')`.
- Do not add a sidebar nav item (history is a sub-page of browser settings, not a top-level settings section).

## Data Layer Design

### Recording model (Rust)

New module `src-tauri/src/embedded_browser/history.rs`:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserHistoryEntry {
    pub id: String,                    // assigned on persist
    pub url: String,
    pub title: Option<String>,
    pub visit_time_ms: i64,            // millisecond timestamp
}
```

**Write points** (all inside existing callbacks in [embedded_browser.rs](../../../../wework/src-tauri/src/embedded_browser.rs)):

1. `on_page_load` (`PageLoadEvent::Finished`): append an entry when the final URL — filtered by the existing `loaded_browser_url` (excludes `about:blank`, maps local preview pages) — is `http`/`https`/`file`. Local files and directories are recorded as their source `file://` URL after preview mapping, so opening them from history re-runs the preview pipeline. Recording at load completion instead of `on_navigation` avoids recording rejected or redirected requests.
2. Title binding to navigation: `on_navigation` marks `pending_history_url` on the webview entry and clears the stale title; a `on_document_title_changed` firing mid-navigation (titles usually arrive before Finished) does not backfill history — the new title is carried by the visit recorded at Finished. The id returned when recording is stored on the webview entry as `last_history_id`, and post-load title changes backfill by that exact id — two tabs visiting the same URL never write to each other's entries.
3. Favicon: not persisted; the frontend loads `${origin}/favicon.ico` directly in an `<img>` and falls back to a default Globe icon on error. Lighter than Codex's data URL storage, at the cost of possible 404s or icon changes.

**Clear race**: `EmbeddedBrowserState.history_generation` (atomic counter). Clearing browsing data first takes the lifecycle lock and passes the webview readiness checks (a failed check errors out with history untouched), then bumps the generation before wiping the store; each navigation stamps the current generation on the webview entry, and the load-finished recording verifies under the store lock that the generation is unchanged — a page that started loading before a clear cannot resurrect cleared entries. If a remove/clear mutates memory but fails to persist, the store is marked unloaded so the next access recovers from the intact file.

**Persistence**: JSON file `app_data_dir()/browser-history.json` (following the `opener_store.rs` app_data_dir pattern; no SQLite). In-memory `VecDeque` capped at **5000 entries** with FIFO eviction; every mutation writes a temporary file and atomically renames it; the file is lazily loaded on first access.

### IPC commands

```
embedded_browser_history_search(
  text: String,            // empty = all; case-insensitive substring on title and url
  end_time_ms: Option<i64>,// pagination cursor: last entry's visitTimeMs + 1; None = from start
  offset: u32,             // cursor correction (multiple entries in the same millisecond)
  max_results: u32,        // frontend always passes 100
) -> Vec<EmbeddedBrowserHistoryEntry>   // ordered by visitTimeMs descending

embedded_browser_history_remove(
  ids: Vec<String>         // delete by record id, avoiding same-URL same-millisecond collisions
) -> u32                   // number of entries actually removed

embedded_browser_clear_data(dataKinds) // existing command, gains a History kind
```

`data_clearing.rs` adds a `History` variant to `EmbeddedBrowserDataKind`: clearing wipes both the JSON file and memory; `kinds == None` (full clear, used by the settings clear-data dialog) includes history.

### Frontend wrapper

New file `src/lib/embedded-browser-history.ts`: `searchEmbeddedBrowserHistory` / `removeEmbeddedBrowserHistoryEntries`, types aligned with the Rust structs (camelCase). Wework does not use TanStack Query; the history page manages pagination state directly with `useState` + `useEffect`, using the same `endTime`/`offset` cursor logic as Codex.

## History List Page

New component `src/components/settings/BrowserHistoryPage.tsx` (expected 600+ lines; per repo rules, split `BrowserHistoryEntryRow` / `BrowserHistoryGroup` if it passes 1000 lines). Structure mirrors Codex:

1. **Header**: back button (to `/settings/browser`) + breadcrumb `Settings / Browser / Browsing history` + page title "Browsing history".
2. **Sticky search box**: placeholder `workbench.browser_history_search` ("Search browsing history"), input debounced by **200 ms** before querying; `data-testid="browser-history-search"`.
3. **Section header row**: "All-time history", with right-aligned buttons:
   - "Remove selected" (visible when entries are checked; loading and disabled while deleting) `data-testid="browser-history-remove-selected"`.
   - "Clear browsing data" (reuse the existing `ClearBrowserDataDialog`, extracted as a shared component for both pages).
4. **Grouped list**: collapsible day groups keyed by `new Date(visitTimeMs).toDateString()`; each group header is a full-width button (rotating chevron + `Intl.DateTimeFormat` date, full `aria-expanded`/`aria-controls`); **the first group is expanded by default**, the rest collapsed.
5. **Entry row** (left to right): checkbox (sr-only label "Select {title}") → favicon (`<img>`, default Globe icon fallback) → title (`title || hostname`, truncated) + hostname in secondary color → time of day on the right (`Intl.DateTimeFormat` hour/minute) → "..." menu (reuse `ActionMenu`): "Open page", "Remove from history".
6. **Infinite scroll**: a bottom sentinel with `IntersectionObserver` loads the next page (100 entries); failures show "Unable to load more browsing history" with a "Try again" button.

### Interaction details (mirroring Codex)

- **Opening an entry**: the title link calls `preventDefault` and opens the URL in the embedded browser (reusing the `openEmbeddedBrowser` flow); rows are disabled while deleting or loading.
- **Single delete**: `embedded_browser_history_remove([id])`; on success the entry is dropped from the selection set and the query refreshes.
- **Bulk delete**: selected record ids are submitted in one call; all rows are disabled in flight.
- Entry key is the backend-assigned record `id`; group key `toDateString()`.

### State copy

| State | Title | Description/action |
| --- | --- | --- |
| Loading | "Loading browsing history" | spinner |
| Load error | "Unable to load browsing history" | "Try again" button |
| No history | "No browsing history yet" | "Pages visited in the built-in browser will appear here" |
| No search results | "No matching pages" | "Try searching for a different page or address" |
| Delete failure | toast "Unable to update browsing history" | TransientNotice |

### i18n

New keys under the `workbench.*` namespace, maintained in both `src/i18n/locales/en/common.json` and `zh-CN/common.json`: `browser_history`, `browser_settings_history*` (label/description/manage), `browser_history_search`, `browser_history_all_time`, `browser_history_remove_selected`, `browser_history_remove`, `browser_history_open_page`, `browser_history_empty*`, `browser_history_no_results*`, `browser_history_loading`, `browser_history_load_error`, `browser_history_pagination_error`, `browser_history_retry`, `browser_history_action_error`.

### data-testid inventory

`workspace-browser-history-item`, `browser-history-manage-button`, `browser-history-page`, `browser-history-back-button`, `browser-history-search`, `browser-history-remove-selected`, `browser-history-clear-data-button`, `browser-history-group-<dateKey>`, `browser-history-entry-<id>`, `browser-history-entry-open-<id>`, `browser-history-entry-remove-<id>`, `browser-history-load-more-sentinel`.

## Known Limitations

- WRY `on_navigation` does not cover SPA `pushState`/`replaceState`; v1 does not record those visits. A later iteration can poll the URL on title change or inject a `history` hook.
- Favicon is fetched live from `${origin}/favicon.ico` instead of Codex's stored data URL; icons may 404 or change with the site, so the frontend always keeps a default icon fallback.
- Multiple webview instances share one global history (consistent with Codex's single session partition).

## Testing

- Rust: `history.rs` unit tests (append/title backfill/capacity eviction/search filtering/cursor pagination/remove/persistence round-trip).
- Frontend Vitest: `BrowserHistoryPage` (grouping, search debounce, select/delete, empty/error/loading states), the new `BrowserSettingsPage` row, and the `WorkspaceBrowserPanel` menu item order and navigation.
- E2E: a new checkpoint — opening a page creates history → enter the history page from the menu → search/delete → history is empty after clearing browsing data. Must be included in a CI-covered suite.

## Task Breakdown

1. Rust `history.rs` store + IPC commands + clear_data integration (with unit tests).
2. Frontend `embedded-browser-history.ts` wrapper.
3. `BrowserHistoryPage` component + routing.
4. Both entries (more-menu item, settings row) + i18n.
5. Extract `ClearBrowserDataDialog` for sharing and wire up remove/clear flows.
6. Vitest + E2E checkpoint.
