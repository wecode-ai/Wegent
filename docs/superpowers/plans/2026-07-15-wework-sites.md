# Wework Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style Sites surface to Wework with external API-backed listing, publishing, confirmed deletion, and a Create action that opens a working fresh chat with Sites selected.

**Architecture:** Wework calls the configured Sites API directly through a tokenless HTTP client. A route-level Sites page reuses the existing Workbench shell, while focused Sites components own list/search/publish/delete state. The Workbench new-chat API selects Sites only for the new blank chat, and the isolated desktop verifier passes one Codex Home consistently through Wework and its local executor so the selected skill can authenticate.

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

### Task 6: Sites DELETE API adapter

**Files:**
- Modify: `wework/src/api/sites.ts`
- Modify: `wework/src/api/sites.test.ts`

- [ ] **Step 1: Write the failing DELETE adapter test**

Add this case to `src/api/sites.test.ts`:

```ts
test('deletes a site using its encoded unique site id', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })

  const api = createSitesApi('http://127.0.0.1:8765/')
  await api.deleteSite('site/1')

  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/api/v1/sites/site%2F1', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Run the adapter test and confirm RED**

Run:

```bash
pnpm --filter wework test -- src/api/sites.test.ts
```

Expected: TypeScript fails because `SitesApi` has no `deleteSite` method.

- [ ] **Step 3: Implement the minimal DELETE adapter**

Extend the public interface and returned adapter in `src/api/sites.ts`:

```ts
export interface SitesApi {
  listSites(input: ListSitesInput): Promise<SiteListResponse>
  publishSite(siteid: string): Promise<Site>
  deleteSite(siteid: string): Promise<void>
}

deleteSite(siteid) {
  return client.delete<void>(`/api/v1/sites/${encodeURIComponent(siteid)}`)
},
```

The existing HTTP client already treats `204 No Content` as a successful null result, so no
HTTP parsing fallback is added.

- [ ] **Step 4: Run the adapter test and confirm GREEN**

Run the same focused test. Expected: all `src/api/sites.test.ts` cases pass.

- [ ] **Step 5: Commit the adapter change**

```bash
git add wework/src/api/sites.ts wework/src/api/sites.test.ts
git commit -m "feat(wework): add site deletion api"
```

### Task 7: Overflow delete action and confirmation flow

**Files:**
- Create: `wework/src/components/sites/SiteActionsMenu.tsx`
- Create: `wework/src/components/sites/DeleteSiteDialog.tsx`
- Modify: `wework/src/components/sites/SitesWorkspace.tsx`
- Modify: `wework/src/components/sites/SitesWorkspace.test.tsx`
- Modify: `wework/src/pages/SitesPage.tsx`
- Modify: `wework/src/i18n/locales/zh-CN/sites.json`
- Modify: `wework/src/i18n/locales/en/sites.json`

- [ ] **Step 1: Extend the fake API and write the confirmation/cancel RED tests**

Add `deleteSite: vi.fn().mockResolvedValue(undefined)` to `createApi()`, then add:

```ts
test('requires confirmation and explains that local files are preserved', async () => {
  const api = createApi()
  render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-more-site-1'))
  await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))

  expect(api.deleteSite).not.toHaveBeenCalled()
  expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('公网入口')
  expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('不会删除本地目录')

  await userEvent.click(screen.getByTestId('site-delete-cancel-button'))
  expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()
  expect(api.deleteSite).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Write the successful deletion RED test**

```ts
test('removes only the confirmed site after the API succeeds', async () => {
  const api = createApi()
  render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-more-site-1'))
  await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))
  await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

  await waitFor(() => expect(api.deleteSite).toHaveBeenCalledWith('site-1'))
  await waitFor(() => expect(screen.queryByTestId('site-row-site-1')).not.toBeInTheDocument())
})
```

- [ ] **Step 3: Write the failed deletion recovery RED test**

```ts
test('keeps the row and dialog open when deletion fails so it can be retried', async () => {
  const api = createApi()
  vi.mocked(api.deleteSite).mockRejectedValueOnce(new Error('公网撤销失败'))
  render(<SitesWorkspace api={api} username="alice" onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-more-site-1'))
  await userEvent.click(screen.getByTestId('site-delete-menu-item-site-1'))
  await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

  expect(await screen.findByRole('alert')).toHaveTextContent('公网撤销失败')
  expect(screen.getByTestId('site-row-site-1')).toBeInTheDocument()
  expect(screen.getByTestId('site-delete-dialog')).toBeInTheDocument()
})
```

- [ ] **Step 4: Run the component tests and confirm RED**

```bash
pnpm --filter wework test -- src/components/sites/SitesWorkspace.test.tsx
```

Expected: failures because the row menu, confirmation dialog, and delete orchestration do not
exist.

- [ ] **Step 5: Implement the focused row actions menu**

Create `SiteActionsMenu.tsx` with this public contract:

```ts
interface SiteActionsMenuProps {
  site: Site
  disabled: boolean
  onDelete: (site: Site) => void
}

export function SiteActionsMenu({ site, disabled, onDelete }: SiteActionsMenuProps) {
  // Keep `open` locally; close on document pointer-down outside the ref and on Escape.
  // Render a 32x32 MoreHorizontal button and an absolute Codex-style popover.
  // The destructive item closes the popover before calling onDelete(site).
}
```

Use these stable selectors and accessibility values in the implementation:

```tsx
<button data-testid={`site-more-${site.siteid}`} aria-label={t('more_actions')} />
<div data-testid={`site-actions-menu-${site.siteid}`} role="menu">
  <button
    data-testid={`site-delete-menu-item-${site.siteid}`}
    role="menuitem"
    className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-danger hover:bg-danger/10"
  >
    <Trash2 className="h-3.5 w-3.5" />
    {t('delete_site')}
  </button>
</div>
```

- [ ] **Step 6: Implement the application confirmation dialog**

Create `DeleteSiteDialog.tsx` with props `{site, loading, error, onCancel, onConfirm}`. Render a
modal overlay with `role="dialog"`, `aria-modal="true"`, the site name, and these controls:

```tsx
<button data-testid="site-delete-cancel-button" disabled={loading} onClick={onCancel}>
  {t('cancel')}
</button>
<button
  data-testid="site-delete-confirm-button"
  disabled={loading}
  onClick={onConfirm}
  className="h-8 rounded-lg bg-danger px-3 text-[13px] font-medium text-white hover:opacity-90"
>
  {loading ? t('deleting') : t('confirm_delete')}
</button>
{error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
```

Clicking the overlay or pressing Escape calls `onCancel` only while `loading` is false.

- [ ] **Step 7: Connect delete state in SitesWorkspace**

Add these states and handler:

```ts
const [pendingDeleteSite, setPendingDeleteSite] = useState<Site | null>(null)
const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null)
const [deleteError, setDeleteError] = useState<string | null>(null)

const deleteSite = async () => {
  if (!pendingDeleteSite || deletingSiteId) return
  setDeletingSiteId(pendingDeleteSite.siteid)
  setDeleteError(null)
  try {
    await api.deleteSite(pendingDeleteSite.siteid)
    setSites(current => current.filter(item => item.siteid !== pendingDeleteSite.siteid))
    setTotal(current => Math.max(0, current - 1))
    setPendingDeleteSite(null)
  } catch (error) {
    setDeleteError(errorMessage(error, t('delete_failed')))
  } finally {
    setDeletingSiteId(null)
  }
}
```

Pass `disabled={publishing || deletingSiteId === site.siteid}` into `SiteActionsMenu`, clear the
old error when opening a new confirmation, and render one `DeleteSiteDialog` at workspace level.
Update `createUnavailableSitesApi()` in `SitesPage.tsx` with a rejecting `deleteSite()` method so
the injected API still satisfies `SitesApi` when the base URL is missing.

- [ ] **Step 8: Add exact Chinese and English copy**

Add equivalent keys to both `sites.json` files:

```json
{
  "more_actions": "更多操作",
  "delete_site": "删除站点",
  "delete_title": "删除站点？",
  "delete_description": "将删除“{{name}}”的站点登记和公网入口，但不会删除本地目录。",
  "cancel": "取消",
  "confirm_delete": "删除",
  "deleting": "删除中",
  "delete_failed": "站点删除失败"
}
```

English values are `More actions`, `Delete site`, `Delete site?`,
`This removes the site registration and public URL for “{{name}}”, but does not delete the local directory.`,
`Cancel`, `Delete`, `Deleting`, and `Failed to delete site`.

- [ ] **Step 9: Run focused tests and commit**

```bash
pnpm --filter wework test -- src/components/sites/SitesWorkspace.test.tsx src/App.plugins.test.tsx
git add wework/src/components/sites wework/src/pages/SitesPage.tsx wework/src/i18n/locales
git commit -m "feat(wework): add confirmed site deletion"
```

Expected: all focused tests pass; cancellation makes no request, success removes one row, and
failure preserves the row and dialog.

### Task 8: Preserve isolated Codex authentication in AI Verify

**Files:**
- Create: `wework/scripts/ai-verify-environment.mjs`
- Create: `wework/scripts/ai-verify-environment.test.mjs`
- Modify: `wework/scripts/ai-verify.mjs`

- [ ] **Step 1: Write the failing environment-builder test**

Create `ai-verify-environment.test.mjs`:

```js
import { describe, expect, test } from 'vitest'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

describe('buildAiVerifyEnvironment', () => {
  test('uses the same isolated Codex home for Wework and its executor', () => {
    const environment = buildAiVerifyEnvironment(
      { PATH: '/usr/bin' },
      {
        controlUrl: 'http://127.0.0.1:9999',
        token: 'control-token',
        codexHome: '/tmp/session/executor-home/codex',
        deviceId: 'device-1',
        socketPath: '/tmp/wework.sock',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.PATH).toBe('/usr/bin')
  })
})
```

- [ ] **Step 2: Run the helper test and confirm RED**

```bash
pnpm --filter wework test -- scripts/ai-verify-environment.test.mjs
```

Expected: module-not-found for `ai-verify-environment.mjs`.

- [ ] **Step 3: Implement and use the environment builder**

Create the pure helper:

```js
export function buildAiVerifyEnvironment(
  processEnvironment,
  { controlUrl, token, codexHome, deviceId, socketPath, executorHome, sessionDirectory }
) {
  return {
    ...processEnvironment,
    VITE_WEWORK_E2E: 'true',
    VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
    VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN: token,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    DEVICE_ID: deviceId,
    WEGENT_EXECUTOR_APP_IPC_SOCKET: socketPath,
    WEGENT_EXECUTOR_HOME: executorHome,
    WEGENT_EXECUTOR_PROJECTS_DIR: join(executorHome, 'workspace', 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: sessionDirectory,
  }
}
```

Import `join` in the helper. Import `buildAiVerifyEnvironment` in `ai-verify.mjs`, then replace
the inline `spawn(..., {env: {...}})` environment with one call passing the existing values.
The helper receives paths only; it never reads or logs `auth.json`.

- [ ] **Step 4: Run the helper test and confirm GREEN**

Run the same focused test. Expected: one passing test.

- [ ] **Step 5: Commit the verifier fix**

```bash
git add wework/scripts/ai-verify.mjs wework/scripts/ai-verify-environment.mjs \
  wework/scripts/ai-verify-environment.test.mjs
git commit -m "fix(wework): preserve ai verify codex authentication"
```

### Task 9: Full verification and real Wework click test

**Files:**
- Modify only if a newly reproduced defect requires a failing regression test first.

- [ ] **Step 1: Run formatting, focused checks, and full Wework verification**

```bash
pnpm --filter wework exec prettier --check \
  src/api/sites.ts src/api/sites.test.ts \
  src/components/sites/SitesWorkspace.tsx \
  src/components/sites/SitesWorkspace.test.tsx \
  src/components/sites/SiteActionsMenu.tsx \
  src/components/sites/DeleteSiteDialog.tsx \
  src/pages/SitesPage.tsx scripts/ai-verify.mjs \
  scripts/ai-verify-environment.mjs scripts/ai-verify-environment.test.mjs
pnpm --filter wework test
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework build
```

Expected: every command exits 0.

- [ ] **Step 2: Start the real Mock Server and isolated Tauri Wework**

Run the Mock Server from `/Users/yunpeng7/AIGCWorkSpace/sites-mock-server` and verify:

```bash
curl -fsS http://127.0.0.1:8765/health
curl -fsS 'http://127.0.0.1:8765/api/v1/sites?username=local&offset=0&limit=20'
VITE_SITES_API_BASE_URL=http://127.0.0.1:8765 pnpm --filter wework ai:verify start
```

Expected: health/list succeed and AI Verify returns a session path without printing its content.

- [ ] **Step 3: Verify delete cancellation, success, and API state**

Use AI Verify selectors in order:

```text
sites-button
site-more-{siteid}
site-delete-menu-item-{siteid}
site-delete-dialog
site-delete-cancel-button
site-more-{siteid}
site-delete-menu-item-{siteid}
site-delete-confirm-button
```

Expected: cancel retains the row and server record; confirm removes the row; a subsequent real
GET list no longer contains that `siteid`. Verify the local test directory still exists, then
capture the final Sites page.

- [ ] **Step 4: Verify Sites skill selection and authenticated message flow**

Click `sites-create-button`, assert the fresh composer displays the Sites chip, send a harmless
test request that does not publish a site, and wait for an assistant response. Inspect the isolated
executor log only for status/error text and confirm it contains no `401 Unauthorized` or
`Missing bearer or basic authentication`; never print authentication-file contents.

- [ ] **Step 5: Stop the isolated session and record evidence**

```bash
pnpm --filter wework ai:verify stop --session <session-path>
```

Expected: the isolated process group terminates and its temporary authentication link is removed.
Record the test commands, actual results, and screenshot paths in the final handoff.
