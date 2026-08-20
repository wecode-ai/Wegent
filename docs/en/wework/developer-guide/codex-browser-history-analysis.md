---
sidebar_position: 46
---

# Codex (ChatGPT Desktop) Built-in Browser History Feature Analysis

> Source: reverse analysis of `codex_app_source` (the ChatGPT desktop app webview bundle), build of 2026-08-11.
> Key files: `webview/assets/app-initial-*.js` (main bundle: data layer and bridge), `webview/assets/browser-use-settings-*.js` (history settings page UI).
> Purpose: reference design for building browser history in the Wework embedded browser.

## Overview

Codex does not implement a standalone chrome://history page. History is **a sub-page inside settings** (route `/settings/browser-use/history`), supported by three companion capabilities:

1. **History list page**: search, day grouping, multi-select delete, per-entry open/delete, infinite scroll.
2. **Clear browsing data dialog**: delete by time range × data type (history, cookies, cache, downloads, form data, site settings).
3. **Browser data import**: first-run (NUX) prompt to import history, cookies, and passwords from Chrome.
4. **History access approval**: controls whether the AI (ChatGPT) may read browsing history (ask every time / always allow / disable).

## Entry Points

| Entry | Behavior |
| --- | --- |
| Browser panel "..." menu → `History` item | Reports telemetry `CODEX_BROWSER_SURFACE_ACTION_TYPE_HISTORY_SELECTED`, navigates to `/settings/browser-use/history`. The item is gated by the `history.enabled` feature flag |
| Typing `chrome://history/` in the address bar | Intercepted and redirected to the same route (`chrome://extensions/` maps to the extensions page similarly) |
| Settings → Browser page → `Browsing history` row | Row description: "View and manage pages visited in the built-in browser"; opens the history page |

## Data Layer

### Bridge architecture

The renderer establishes an RPC bridge to the native host via `window.postMessage({type: 'connect-app-host', port})` (MessageChannel) and receives a `services` object. Browsing history is one of those services: `services.browsingHistory`. Method signatures reconstructed from call sites:

```
searchHistory(query: {
  text: string        // search term; empty string matches everything
  startTime: number   // always 0
  endTime?: number    // pagination cursor: last entry's visitTime + 1
  maxResults: number  // always 100
  offset: number      // pagination offset (corrects for multiple entries in the same millisecond)
}): Promise<HistoryEntry[]>

removeEntries(entries: { url: string, visitTime: number }[]): Promise<void>

clearBrowsingData(options: {
  dataTypes: ('history'|'siteData'|'cache'|'downloads'|'formData'|'siteSettings')[]
  timeRange: 'lastHour'|'lastDay'|'lastWeek'|'lastMonth'|'allTime'
}): Promise<void>

getBrowsingDataSettings(): Promise<BrowsingDataSettings>   // per-type clearing policy/defaults
getBrowsingDataSummary(): Promise<{                        // summaries for the clear dialog
  history: { siteCount: number, firstSite?: string }
  downloads: { count: number }
  cache: { size: ... }
  ...
}>
```

Recording (writes) happens entirely on the native side (Electron session partition `persist:codex-browser-app`); the webview frontend only reads and deletes.

### History entry format

```ts
interface HistoryEntry {
  id: string              // record id (part of the DOM key)
  url: string
  title: string           // page title, may be empty
  visitTime: number       // millisecond timestamp
  faviconDataURL?: string // data:image/ favicon; invalid values are dropped in favor of a default globe icon
}
```

The unique key of an entry is `` `${url}\0${visitTime}` ``; the group key is `new Date(visitTime).toDateString()`.

### Frontend fetching (TanStack Query)

- `useInfiniteQuery` with queryKey `['browser-browsing-history', searchText]`, 100 entries per page.
- Pagination cursor: `endTime = last entry's visitTime + 1`; `offset` accumulates entries with `visitTime < endTime` from previous pages to avoid duplicates/gaps for same-millisecond visits.
- `staleTime: 5s`, `refetchOnMount: 'always'`, `retry: false`; `placeholderData` reuses cached results from other search terms to avoid flicker while typing.
- When the service is unavailable the query throws `Browser history is unavailable` and the page redirects back to `/settings/browser-use`.

## History Page UI and Interactions

### Page structure (top to bottom)

1. **Header toolbar**: back button (to `/settings/browser-use`) + breadcrumb `Settings / Browser / Browsing history` + page title "Browsing history".
2. **Sticky search box**: placeholder "Search browsing history"; input is debounced by **200 ms** before driving the query.
3. **Section header row**: "All-time history", with action buttons on the right:
   - `Remove selected` (appears when entries are checked; disabled without delete permission or while a deletion is in flight, showing a loading state).
   - `Clear browsing data` (opens the clear browsing data dialog).
4. **Grouped list**: collapsible disclosure groups per day. Each group header is a full-width button: rotating chevron + formatted date (`day: numeric, month: short, year: numeric`), with proper `aria-expanded`/`aria-controls`. **The first group is expanded by default**, the rest are collapsed; expansion state lives in a local `Set<groupKey>`.
5. **Infinite-scroll sentinel**: entering the viewport triggers `fetchNextPage`; on failure it shows "Unable to load more browsing history" with a `Try again` button.

### Anatomy of an entry row

A row (highlighted on hover and `focus-within` via `bg-token-list-hover-background`) contains, left to right:

- **Checkbox** (wrapped in a label with sr-only text "Select {title}"; disabled without delete permission or during deletion).
- **Favicon**: if `faviconDataURL` starts with `data:image/`, an `<img class="icon-sm rounded-2xs">`; otherwise a default globe icon.
- **Title + hostname**: an `<a>` whose primary text is `title || hostname` (truncated), followed by the hostname in secondary color (`new URL(url).hostname || url`); the link underlines on hover, aria-label "Open {title}".
- **Time** on the right: `FormattedTime` (hours/minutes), styled `text-sm text-token-text-secondary`.
- **"..." row menu** (aria-label "Actions for {title}"):
  - `Open page` (with open icon)
  - `Remove from history` (with delete icon, disabled without permission or during deletion)

### Interaction details

- **Opening an entry**: clicking the title link calls `preventDefault` and goes through internal open logic — if the current conversation already has a browser tab with that URL, it focuses that tab and returns to the conversation view; otherwise it opens the URL in the in-app browser. Modifier-key clicks (cmd/ctrl) take the "open in new tab" path. The initiator is tagged `open_in_browser_bridge`.
- **Single delete**: `removeEntries([{url, visitTime}])`; on success the entry is removed from the selection set and `['browser-browsing-history']` queries are invalidated.
- **Bulk delete**: selected entries are mapped to `{url, visitTime}[]` and submitted in one call; all rows are disabled while the mutation is in flight.
- **Permission gating**: deletion (checkboxes, `Remove selected`, `Remove from history`) requires `browsingDataSettings.dataRemovalPermitted.history === true`.
- **Error handling**: failures show a danger toast. If the error message matches `/policy|permission|prohibit|denied|not allowed|restricted/i` (enterprise policy), the toast shows the specific policy error "Unable to update browsing history: {error}"; otherwise a generic "Unable to update browsing history".

### State copy

| State | Title | Description |
| --- | --- | --- |
| Loading | "Loading browsing history" | — |
| Load error | "Unable to load browsing history" | With a `Try again` button |
| No history | "No browsing history yet" | "Pages visited in the built-in browser will appear here" |
| No search results | "No matching pages" | "Try searching for a different page or address" |

## Clear Browsing Data Dialog

- **Time ranges**: `Last hour` / `Last 24 hours` / `Last 7 days` / `Last 4 weeks` / `All time`; default `lastHour`.
- **Data types** (checkboxes, defaults from `getBrowsingDataSettings()`): `Browsing history`, `Cookies and site data`, `Cached images and files`, `Download history`, `Autofill form data`, `Site settings`.
- Each type shows a summary from `getBrowsingDataSummary(timeRange)`, e.g. history shows `From {firstSite} + {n} sites` / `No sites visited`, cache shows `Current cache size: {size}`, downloads show `{count} downloads`.
- Confirm button "Delete data", cancel "Cancel"; success toasts (e.g. "Browser history cleared"), failure toast "Unable to clear browsing data".
- The settings page additionally offers per-type delete buttons (Delete browsing history / Delete cookies / Delete cached images and files / Delete download history / Delete site data) behind a "Show/Hide individual browsing data options" toggle, plus a global "Clear all browsing data" entry.

## Related Capabilities

- **Browser data import**: NUX modal "Import from your browser" with checkboxes for Cookies / Saved passwords / Browsing history; the history benefit copy is "Find familiar sites faster". An "Import…" entry remains in settings.
- **AI history access approval** (Settings → Permissions): "Choose whether ChatGPT can access your built-in browser history", three options — `Always ask` ("Ask before accessing history"), `Always allow` ("Access history without asking", flagged as elevated risk), `Disable` ("Do not allow access to history"). Save failures toast "Unable to save history setting".
- **Address bar suggestions**: the address bar dropdown ("Address suggestions") shows matches plus a "Search the web for '{query}'" fallback; history is one of the suggestion sources.

## Recommendations for Wework

1. **Recording on the Rust/Tauri side**: mirror Codex's session-partition approach — write to local SQLite from the webview navigation event (`onNavigation`) under the Wework local data directory, with fields aligned to `id / url / title / visitTime / favicon`.
2. **IPC aligned with the bridge protocol**: three commands cover the whole page — `search_history(text, startTime, endTime, maxResults, offset)`, `remove_entries(entries)`, `clear_browsing_data(dataTypes, timeRange)`. Use the "last visitTime + offset" cursor for pagination, not a plain offset.
3. **Reuse the existing settings page skeleton**: Wework already has settings routes and list-row components; the history page can be a browser-settings sub-page following Codex's "breadcrumb + sticky search + collapsible day groups + infinite scroll" structure.
4. **Favicon storage**: capture the favicon on navigation, store it as a data URL or cached file, validate the `data:image/` prefix when rendering, and keep a default icon fallback.
5. **Permissions and policy**: gate deletion separately (like `dataRemovalPermitted`), and give AI access to history its own approval setting (like `iabHistoryApproval`). Treat these as two separate dimensions during requirement analysis.
