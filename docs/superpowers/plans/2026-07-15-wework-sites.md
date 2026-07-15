# Wework Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style Sites surface to Wework with external API-backed listing and publishing plus a Create action that opens a fresh chat with Sites selected.

**Architecture:** Wework calls the configured Sites API directly through a tokenless HTTP client. A route-level Sites page reuses the existing Workbench shell, while focused Sites components own list/search/publish state. The Workbench new-chat API gains a scoped preselection option so the Sites entry skill is selected only for the new blank chat.

**Tech Stack:** React 19, TypeScript 6, Vite, Vitest, Testing Library, Tailwind CSS, Tauri 2

---

### Task 1: Runtime configuration and Sites API adapter

**Files:**
- Modify: `wework/src/config/runtime.ts`
- Modify: `wework/src/config/runtime.test.ts`
- Modify: `wework/src/api/http.ts`
- Modify: `wework/src/api/http.test.ts`
- Create: `wework/src/api/sites.ts`
- Create: `wework/src/api/sites.test.ts`

- [ ] **Step 1: Write failing configuration and HTTP error tests**

Add assertions that `VITE_SITES_API_BASE_URL` and runtime overrides populate a trimmed
`sitesApiBaseUrl`, and that an HTTP response shaped as
`{error:{code:'site_publish_failed',message:'CDN failed'}}` becomes an `ApiError`
with that message and error code.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter wework test -- src/config/runtime.test.ts src/api/http.test.ts
```

Expected: failures because `sitesApiBaseUrl` and nested `error` parsing do not exist.

- [ ] **Step 3: Implement configuration and nested error parsing**

Extend `RuntimeConfig` and `getRuntimeConfig()` with:

```ts
sitesApiBaseUrl:
  runtimeString(overrides, 'sitesApiBaseUrl') ||
  import.meta.env.VITE_SITES_API_BASE_URL?.trim() ||
  ''
```

Normalize the returned value with the existing trailing-slash helper. Extend
`parseError()` so `json.error.message` and `json.error.code` are recognized without
changing existing `detail` behavior.

- [ ] **Step 4: Write a failing Sites adapter test**

Test the desired API:

```ts
const api = createSitesApi('http://127.0.0.1:8765')
await api.listSites({ username: 'yunpeng7', query: '产品', offset: 20, limit: 20 })
await api.publishSite('site-product')
```

Assert the GET URL contains encoded `username`, `q`, `offset`, and `limit`, the POST
uses `/api/v1/sites/site-product/publish`, and neither request carries an
`Authorization` header.

- [ ] **Step 5: Run the adapter test and confirm RED**

Run:

```bash
pnpm --filter wework test -- src/api/sites.test.ts
```

Expected: module-not-found failure for `src/api/sites.ts`.

- [ ] **Step 6: Implement the minimal adapter**

Create the API types and constructor:

```ts
export type SitePublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed'

export interface Site {
  siteid: string
  name: string
  slug: string
  internal_url: string
  external_url: string | null
  publish_status: SitePublishStatus
  last_publish_error: string | null
  thumbnail_url: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

export interface SiteList {
  items: Site[]
  total: number
  offset: number
  limit: number
}
```

Use `createHttpClient({baseUrl, getToken: () => null, redirectOnUnauthorized: false})`.

- [ ] **Step 7: Run focused tests and commit**

Run the three focused files and commit with:

```bash
git add wework/src/config/runtime.ts wework/src/config/runtime.test.ts \
  wework/src/api/http.ts wework/src/api/http.test.ts \
  wework/src/api/sites.ts wework/src/api/sites.test.ts
git commit -m "feat(wework): add sites api client"
```

### Task 2: Sites list workspace and publishing interactions

**Files:**
- Create: `wework/src/components/sites/SiteListItem.tsx`
- Create: `wework/src/components/sites/SitesWorkspace.tsx`
- Create: `wework/src/components/sites/SitesWorkspace.test.tsx`
- Create: `wework/src/i18n/locales/zh-CN/sites.json`
- Create: `wework/src/i18n/locales/en/sites.json`
- Modify: `wework/src/i18n/index.ts`

- [ ] **Step 1: Write failing component tests for initial list and status rows**

Render `SitesWorkspace` with an injected fake API and assert:

```ts
expect(api.listSites).toHaveBeenCalledWith({
  username: 'yunpeng7',
  query: '',
  offset: 0,
  limit: 20,
})
expect(screen.getByText('内部地址')).toBeInTheDocument()
expect(screen.getByText('发布')).toBeEnabled()
expect(screen.getByText('已发布')).toBeDisabled()
```

Cover `unpublished`, `publishing`, `published`, and `failed` rows.

- [ ] **Step 2: Run the component test and confirm RED**

Run:

```bash
pnpm --filter wework test -- src/components/sites/SitesWorkspace.test.tsx
```

Expected: module-not-found failure for the new workspace.

- [ ] **Step 3: Implement the list and row components**

Build a 920px maximum-width, single-column workspace using Wework semantic tokens.
Use `openExternalUrl()` for URLs, `Globe2` as the thumbnail fallback, and icon-plus-text
status labels. Add descriptive test IDs including `sites-search-input`,
`site-row-{siteid}`, and `site-publish-{siteid}`.

- [ ] **Step 4: Write failing tests for search, refresh, paging, and errors**

Use fake timers to verify the 180ms search debounce, assert Load More requests the next
offset, confirm Refresh preserves the query, and assert a failed request exposes a Retry
button without discarding existing rows.

- [ ] **Step 5: Run the new tests and confirm RED**

Expected: missing state transitions and actions.

- [ ] **Step 6: Implement search and page state**

Use request sequence IDs to ignore stale responses. Maintain `items`, `total`, `loading`,
`refreshing`, `loadingMore`, and `error`. Replace the target item with the publish response;
on `site_publish_in_progress`, set the target status to `publishing`; on 502, retain the item
and show its retryable error.

- [ ] **Step 7: Register the Sites i18n namespace and make tests GREEN**

Add `sites` resources to `src/i18n/index.ts`, keep visible strings in the two JSON files,
then run the focused component test.

- [ ] **Step 8: Commit the workspace**

```bash
git add wework/src/components/sites wework/src/i18n
git commit -m "feat(wework): add sites list and publishing"
```

### Task 3: Scoped Sites skill preselection for new chats

**Files:**
- Modify: `wework/src/features/workbench/workbenchContextTypes.ts`
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
- Create: `wework/src/lib/local-skill-reference.ts`

- [ ] **Step 1: Write a failing Workbench provider test**

Add a test harness action that calls:

```ts
await workbench.startNewSkillChat(['sites:sites-building'])
```

With a loaded Sites skill, assert the standalone chat key increments and the current route
becomes `/`. Cover both a unified `SkillRef` and a local app-server skill mention whose path
points to `SKILL.md`. Also assert the old blank scope retains its selection.

- [ ] **Step 2: Run the provider test and confirm RED**

Expected: TypeScript/runtime failure because `startNewChat` has no options and skills cannot
be written to a target scope.

- [ ] **Step 3: Add scoped selection support**

Expose from `useWorkbenchSkills`:

```ts
const setSelectedSkillsForScope = useCallback((targetScopeKey: string, skills: SkillRef[]) => {
  if (locked) return false
  setSelectedSkillsByScope(current => ({ ...current, [targetScopeKey]: skills }))
  return true
}, [locked])
```

Add `startNewSkillChat`. Resolve requested skills first from `skillSelection.skills`, then from
a force-refreshed local Codex skill list. Compute the target blank scope before dispatch, set
only that scope, then navigate and request composer focus. Return `false` without navigating
when a requested skill is unavailable.

- [ ] **Step 4: Add and pass the unavailable-skill test**

Assert the chat key and location stay unchanged when `sites:sites-building` is missing.

- [ ] **Step 5: Commit the scoped chat change**

```bash
git add wework/src/features/workbench
git commit -m "feat(wework): preselect skills in fresh chats"
```

### Task 4: Sites route, sidebar entry, and Create action

**Files:**
- Create: `wework/src/pages/SitesPage.tsx`
- Modify: `wework/src/App.tsx`
- Modify: `wework/src/App.plugins.test.tsx`
- Modify: `wework/src/components/layout/DesktopSidebar.tsx`
- Modify: `wework/src/components/layout/DesktopSidebar.test.tsx`
- Modify: `wework/src/components/layout/MobileDrawer.tsx`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.tsx`
- Modify: `wework/src/components/layout/MobileWorkbenchLayout.tsx`

- [ ] **Step 1: Write failing sidebar and route tests**

Assert `sites-button` navigates to `/sites`, the Sites route renders `sites-workspace`, the
button has selected state, and Workbench stays mounted but hidden.

- [ ] **Step 2: Run the route tests and confirm RED**

Run:

```bash
pnpm --filter wework test -- src/App.plugins.test.tsx src/components/layout/DesktopSidebar.test.tsx
```

Expected: missing Sites navigation and route.

- [ ] **Step 3: Implement navigation and the route shell**

Add `'sites'` to sidebar active-item unions, add `onOpenSites`, render a Lucide layout/grid
icon with the translated label, and register `/sites` as an auxiliary route in `App.tsx`.
Create `SitesPage` by following the existing `PluginsPage` shell pattern and render
`SitesWorkspace` with the current `user_name` and `sitesApiBaseUrl`.

- [ ] **Step 4: Write a failing Create action test**

On the Sites page, click `sites-create-button` and assert the route changes to `/`, a fresh
chat is active, and the `sites:sites-building` skill is selected. When the skill is absent, assert
the route remains `/sites` and an alert plus `sites-open-plugins-button` appears.

- [ ] **Step 5: Implement Create and recovery behavior**

Await `startNewSkillChat(['sites:sites-building'])`. If it returns false, show an accessible
inline error with a button navigating to `/plugins`. The standard composer renders the Sites
chip; do not prefill a prompt or send text.

- [ ] **Step 6: Make route and sidebar tests GREEN and commit**

```bash
git add wework/src/App.tsx wework/src/pages/SitesPage.tsx wework/src/components/layout
git commit -m "feat(wework): add sites route and create entry"
```

### Task 5: Verification and real desktop click-through

**Files:**
- Modify only if verification exposes a tested defect.

- [ ] **Step 1: Run focused and full automated checks**

```bash
pnpm --filter wework test
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm exec prettier --check wework/src
pnpm --filter wework build
```

All commands must exit 0. Fix any defect by first adding or refining a failing test.

- [ ] **Step 2: Validate the external API is available**

```bash
curl -fsS http://127.0.0.1:8765/health
curl -fsS 'http://127.0.0.1:8765/api/v1/sites?username=yunpeng7&offset=0&limit=20'
```

Expected: health success and a SiteList response.

- [ ] **Step 3: Start the actual Wework desktop app**

Start with:

```bash
VITE_SITES_API_BASE_URL=http://127.0.0.1:8765 pnpm --filter wework dev:mac
```

Keep the process alive for manual verification.

- [ ] **Step 4: Click through the user flow**

Using Computer Use, click the sidebar Sites entry, enter a search term, open an internal URL,
publish an unpublished record, verify the external URL appears, click Create, and verify the
fresh composer shows Sites selected with no auto-sent prompt.

- [ ] **Step 5: Run the Wework AI verification scenario**

Run the real Tauri verifier for the Sites route and retain its artifact path. If the verifier
finds a defect, reproduce it in a failing automated test before fixing it.

- [ ] **Step 6: Commit any verification-only fixes**

Use a focused Conventional Commit only when this phase changed files.
