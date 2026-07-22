---
sidebar_position: 1
---

# Wework Explicit Terminal Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottom workspace panel show its tool launcher until Terminal is explicitly selected, while preserving created terminals and exposing Terminal, IDE, and internal Desktop in the add menu.

**Architecture:** Keep session ownership and capability decisions in `WorkspacePanelCards`. Publish a small set of menu actions from each mounted tab to `BottomWorkspacePanel`; the bottom panel uses those actions for IDE and Desktop and creates a new explicitly-started tab for Terminal. Replace the card-only cloud desktop component call with the existing programmatic `cloudDesktopExtension.open` boundary so cards and menu items share one open path.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri desktop E2E, pnpm.

---

## File Map

- Modify `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx`: publish shared tool actions, add the programmatic desktop open path, and support preserving the panel for menu actions.
- Create `wework/src/components/layout/workspace-panels/workspace-panel-tools.ts`: hold the shared menu action types and the existing pure workspace-panel helper types/functions moved out of the 1000-line component.
- Modify `wework/src/components/layout/workspace-panels/BottomWorkspacePanel.tsx`: stop auto-launching the first tab, register active-tab actions, and build the three-item add menu.
- Modify `wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx`: cover shared IDE/Desktop actions, programmatic desktop opening, and failure preservation.
- Modify `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`: update existing bottom-panel and task-preservation tests, and cover the integrated three-item menu with a mutable internal-extension mock.
- Modify `wework/e2e/desktop/task-flow.e2e.mjs`: add real desktop regression coverage for new and historical cloud tasks.

## Task 1: Lock the explicit-launch regression in workbench tests

**Files:**

- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx:6930-7375`
- Modify: `wework/src/components/layout/workspace-panels/BottomWorkspacePanel.tsx:14-205`

- [ ] **Step 1: Replace the old auto-open assertion with a failing launcher assertion**

Replace `opens the terminal by default when the bottom workspace panel opens` with:

```tsx
test('shows workspace tools before explicitly opening the bottom terminal', async () => {
  renderWorkspacePanelLayout()

  await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

  expect(screen.getByTestId('workspace-tool-launcher')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-terminal-card')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-ide-card')).toBeInTheDocument()
  expect(startTerminalSessionMock).not.toHaveBeenCalled()
  expect(screen.queryByTestId('remote-terminal')).not.toBeInTheDocument()

  await userEvent.click(screen.getByTestId('workspace-terminal-card'))

  await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12))
  expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "shows workspace tools before explicitly opening the bottom terminal"
```

Expected: FAIL because `startTerminalSessionMock` is called as soon as the bottom panel opens and the launcher disappears.

- [ ] **Step 3: Stop passing the automatic tool to the initial bottom tab**

Extend the bottom-tab type so only tabs created by an explicit add-menu selection carry an initial tool:

```tsx
interface BottomWorkspacePanelTab {
  id: string
  title: string
  defaultOpenTool?: 'terminal'
}

function createTerminalTab(
  index: number,
  defaultOpenTool?: BottomWorkspacePanelTab['defaultOpenTool']
): BottomWorkspacePanelTab {
  return { id: `terminal-${index}`, title: `Terminal ${index}`, defaultOpenTool }
}
```

Keep both the initial state and the reopen-after-empty effect on `createTerminalTab(index)` with no tool. Change the existing add-menu Terminal path to call:

```tsx
const openTerminalTab = () => {
  const tab = createTerminalTab(terminalSequenceRef.current, 'terminal')
  terminalSequenceRef.current += 1
  setTabs(current => [...current, tab])
  setActiveTabId(tab.id)
}
```

Pass the tab-specific value instead of opening every active tab:

```tsx
<WorkspacePanelCards
  currentProject={currentProject}
  devices={devices}
  workspaceTarget={workspaceTarget}
  defaultOpenTool={tab.defaultOpenTool}
/>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: PASS; no terminal API runs before the card click, then one remote terminal opens.

- [ ] **Step 5: Update existing terminal tests to click explicitly**

In these existing tests, click `workspace-terminal-card` immediately after opening a previously unused bottom-panel context and before expecting a terminal API call:

- `opens a local project terminal when a project is selected without an active task`
- `uses local mode for a selected git project without an active task`
- `opens the selected runtime project workspace path instead of the home directory`
- `preserves bottom terminal state per runtime task` for Task A and the first visit to Task B; do not click when returning to Task A, because that assertion proves restoration
- `keeps runtime task terminals past the pane cache limit until the task is archived` for each task's first visit

Use the same explicit action in each first-visit path:

```tsx
await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
```

- [ ] **Step 6: Run the affected workbench tests**

Run:

```bash
pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "bottom|local project terminal|local mode|selected runtime project workspace|preserves bottom terminal|keeps runtime task terminals"
```

Expected: PASS with no unhandled promise rejections.

- [ ] **Step 7: Commit the explicit-launch behavior**

```bash
git add wework/src/components/layout/DesktopWorkbenchLayout.test.tsx wework/src/components/layout/workspace-panels/BottomWorkspacePanel.tsx
git commit -m "fix(wework): require explicit bottom terminal launch"
```

## Task 2: Publish shared tool actions and unify desktop opening

**Files:**

- Create: `wework/src/components/layout/workspace-panels/workspace-panel-tools.ts`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx:1-1013`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx:1-864`

- [ ] **Step 1: Write failing tests for reusable IDE and Desktop menu actions**

Add `act` to the Testing Library import and capture the published actions:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react'
import type { WorkspacePanelMenuActions } from './workspace-panel-tools'
```

Set the desktop mock to succeed in `beforeEach`:

```tsx
cloudDesktopExtensionMock.open.mockResolvedValue(true)
```

Add:

```tsx
test('publishes IDE and desktop menu actions that preserve the panel', async () => {
  const onRequestClose = vi.fn()
  let actions: WorkspacePanelMenuActions | null = null
  render(
    <WorkspacePanelCards
      currentProject={cloudProject}
      devices={cloudDevices}
      onRequestClose={onRequestClose}
      onMenuActionsChange={next => {
        actions = next
      }}
    />
  )

  await waitFor(() => expect(actions?.desktop.visible).toBe(true))

  await act(async () => {
    await actions?.ide.run()
  })
  expect(window.open).toHaveBeenCalledWith(
    'http://localhost/ide',
    '_blank',
    'noopener,noreferrer'
  )
  expect(onRequestClose).not.toHaveBeenCalled()

  await act(async () => {
    await actions?.desktop.run()
  })
  expect(cloudDesktopExtensionMock.open).toHaveBeenCalledWith(
    expect.objectContaining({
      deviceId: 'device-1',
      isCurrent: expect.any(Function),
    })
  )
  expect(onRequestClose).not.toHaveBeenCalled()
})
```

Update the existing desktop-card test so the card must call `cloudDesktopExtension.open`, while still calling `onRequestClose` after a successful card open:

```tsx
await userEvent.click(screen.getByTestId('workspace-desktop-card'))

await waitFor(() => expect(cloudDesktopExtensionMock.open).toHaveBeenCalledTimes(1))
expect(onRequestClose).toHaveBeenCalledTimes(1)
```

Add an error-path test that starts a terminal first, then invokes the published Desktop action:

```tsx
test('keeps the active terminal visible when a desktop menu action fails', async () => {
  cloudDesktopExtensionMock.open.mockRejectedValueOnce(new Error('desktop unavailable'))
  let actions: WorkspacePanelMenuActions | null = null
  render(
    <WorkspacePanelCards
      currentProject={cloudProject}
      devices={cloudDevices}
      onMenuActionsChange={next => {
        actions = next
      }}
    />
  )
  await userEvent.click(screen.getByTestId('workspace-terminal-card'))
  await screen.findByTestId('remote-terminal')
  await waitFor(() => expect(actions?.desktop.visible).toBe(true))

  await act(async () => {
    await actions?.desktop.run()
  })

  expect(screen.getByTestId('remote-terminal')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-tool-error')).toHaveTextContent('启动失败')
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter wework test -- src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx -t "publishes IDE and desktop menu actions|renders the project desktop"
```

Expected: FAIL because `onMenuActionsChange` does not exist and the card still delegates to `WorkspaceAction`.

- [ ] **Step 3: Create the shared action types and move pure helpers**

Create `workspace-panel-tools.ts` with the shared public types:

```ts
import type { ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'
import { configuredWorkspacePath } from '@/lib/project-workspace'

export type WorkspaceTool = 'terminal' | 'ide' | 'desktop'

export interface WorkspacePanelMenuAction {
  visible: boolean
  disabled: boolean
  run: () => Promise<void>
}

export type WorkspacePanelMenuActions = Record<WorkspaceTool, WorkspacePanelMenuAction>

export type WorkspaceTerminalSessionBase = ProjectDeviceSessionResponse & {
  cwd?: string
  title?: string
}

export function getProjectDeviceId(project: ProjectWithTasks | null): string | undefined {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function getProjectLocalPath(project: ProjectWithTasks): string | undefined {
  return configuredWorkspacePath(project)
}

export function usesLocalProjectConfig(project: ProjectWithTasks | null): boolean {
  return Boolean(
    project &&
      (project.config?.execution?.targetType === 'local' ||
        project.config?.workspace?.source === 'local_path')
  )
}
```

Move these pure helpers into the same file and export them:

```ts
export function getPathBasename(path?: string | null): string {
  const normalizedPath = path?.trim().replace(/\/+$/, '')
  if (!normalizedPath || normalizedPath === '/') return ''
  return normalizedPath.split('/').filter(Boolean).pop() ?? ''
}

export function getTerminalSessionLabel(
  session: (WorkspaceTerminalSessionBase & { session_id: string }) | null
): string {
  if (!session) return ''

  const title = session.title?.trim()
  if (title) return title

  return (
    getPathBasename(session.cwd) ||
    getPathBasename(session.path) ||
    session.device_id?.trim() ||
    session.session_id
  )
}

export function buildLocalTerminalEnv({
  title,
  projectName,
  workspacePath,
}: {
  title?: string | null
  projectName?: string | null
  workspacePath?: string | null
}): Record<string, string> | undefined {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) return undefined

  const env: Record<string, string> = { WEWORK_PARENT_TITLE: normalizedTitle }
  const normalizedProjectName = projectName?.trim()
  const normalizedWorkspacePath = workspacePath?.trim()
  if (normalizedProjectName) env.WEWORK_PARENT_PROJECT = normalizedProjectName
  if (normalizedWorkspacePath) env.WEWORK_PARENT_WORKSPACE = normalizedWorkspacePath
  return env
}
```

Import all moved helpers into `WorkspacePanelCards.tsx`. The extraction reduces the component below the repository's 1000-line split threshold while retaining its covered behavior.

- [ ] **Step 4: Add the programmatic Desktop action**

Import `Monitor` and `useOptionalCloudConnection` in `WorkspacePanelCards.tsx`. Build the existing extension connection payload from the hook:

```tsx
const cloudConnection = useOptionalCloudConnection()
const latestProjectKeyRef = useRef(projectKey)
latestProjectKeyRef.current = projectKey
```

Replace `handleExtensionBusyChange` and `handleExtensionOpened` with one callback that owns the same loading and error state:

```tsx
const handleDesktopClick = useCallback(
  async (closePanelOnSuccess: boolean) => {
    if (!activeWorkspaceDeviceId || loadingTool || !cloudDesktopExtension.available) return

    setLoadingToolState({ tool: 'extension', projectKey })
    setProjectError(null)
    try {
      const opened = await cloudDesktopExtension.open({
        connection: {
          apiBaseUrl: cloudConnection.apiBaseUrl,
          isConnected: cloudConnection.isConnected,
          socketBaseUrl: cloudConnection.socketBaseUrl,
          token: cloudConnection.token,
        },
        deviceId: activeWorkspaceDeviceId,
        isCurrent: () => latestProjectKeyRef.current === projectKey,
      })
      if (opened && closePanelOnSuccess) onRequestClose?.()
    } catch (error) {
      console.error('Failed to open project desktop:', error)
      setProjectError(getSessionStartErrorMessage())
    } finally {
      setLoadingToolState(current =>
        current?.tool === 'extension' && current.projectKey === projectKey ? null : current
      )
    }
  },
  [
    activeWorkspaceDeviceId,
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.socketBaseUrl,
    cloudConnection.token,
    getSessionStartErrorMessage,
    loadingTool,
    onRequestClose,
    projectKey,
    setProjectError,
  ]
)
```

Render the Desktop card in `WorkspacePanelCards` with the same card dimensions as Terminal and IDE, `Monitor`, `workbench.desktop`, and `workbench.open_project_desktop`. The card calls:

```tsx
onClick={() => void handleDesktopClick(true)}
```

Keep its existing visibility condition:

```tsx
cloudToolsAvailable && cloudDesktopExtension.available && activeWorkspaceDeviceId
```

- [ ] **Step 5: Allow IDE callers to preserve the panel**

Wrap the IDE handler in `useCallback` and add the close policy argument. Replace the current declaration:

```tsx
const handleIdeClick = async (
  opener: LocalWorkspaceOpenerId = DEFAULT_LOCAL_WORKSPACE_OPENER_ID
) => {
```

with:

```tsx
const handleIdeClick = useCallback(async (
  opener: LocalWorkspaceOpenerId = DEFAULT_LOCAL_WORKSPACE_OPENER_ID,
  closePanelOnSuccess = true
) => {
```

Keep the local-workspace and remote-code-server branches byte-for-byte unchanged. Replace the final close block:

```tsx
if (shouldClosePanel) onRequestClose?.()
```

with:

```tsx
if (shouldClosePanel && closePanelOnSuccess) onRequestClose?.()
```

Close the callback with this dependency list:

```tsx
}, [
  activeWorkspaceDeviceId,
  activeWorkspacePath,
  availableTools.ide,
  currentProject,
  getSessionStartErrorMessage,
  loadingTool,
  localIdeLaunchable,
  markToolUnavailable,
  onRequestClose,
  projectKey,
  setProjectError,
  useDeviceCodeServerSession,
  workspaceSessionApi,
])
```

Existing cards and picker calls omit the second argument, preserving their current behavior.

- [ ] **Step 6: Publish one menu action set**

Add the optional prop:

```tsx
onMenuActionsChange?: (actions: WorkspacePanelMenuActions | null) => void
```

Create a memoized action set after all handlers are defined:

```tsx
const menuActions = useMemo<WorkspacePanelMenuActions>(
  () => ({
    terminal: {
      visible: projectTerminalAvailable,
      disabled: toolsDisabled || !availableTools.terminal,
      run: startTerminalSession,
    },
    ide: {
      visible: projectIdeAvailable,
      disabled: toolsDisabled || !availableTools.ide,
      run: () => handleIdeClick(DEFAULT_LOCAL_WORKSPACE_OPENER_ID, false),
    },
    desktop: {
      visible: Boolean(
        cloudToolsAvailable && cloudDesktopExtension.available && activeWorkspaceDeviceId
      ),
      disabled: toolsDisabled || projectDevice?.status !== 'online',
      run: () => handleDesktopClick(false),
    },
  }),
  [
    activeWorkspaceDeviceId,
    availableTools.ide,
    availableTools.terminal,
    cloudToolsAvailable,
    handleDesktopClick,
    handleIdeClick,
    projectDevice?.status,
    projectIdeAvailable,
    projectTerminalAvailable,
    startTerminalSession,
    toolsDisabled,
  ]
)

useEffect(() => {
  onMenuActionsChange?.(menuActions)
  return () => onMenuActionsChange?.(null)
}, [menuActions, onMenuActionsChange])
```

- [ ] **Step 7: Keep menu-action errors visible over an active terminal**

Immediately after `terminalWindow`, render the current project error as a compact overlay only when a terminal is active:

```tsx
{activeTerminalSession && error && (
  <p
    data-testid={testId('workspace-tool-error')}
    className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500 shadow-sm"
    role="alert"
  >
    {error}
  </p>
)}
```

- [ ] **Step 8: Run tests and verify GREEN**

Run:

```bash
pnpm --filter wework test -- src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx
```

Expected: all `WorkspacePanelCards` tests pass, including local, remote, IDE, and Desktop cases.

- [ ] **Step 9: Commit shared actions**

```bash
git add wework/src/components/layout/workspace-panels/workspace-panel-tools.ts wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx
git commit -m "refactor(wework): share workspace tool actions"
```

## Task 3: Add the three-item bottom-panel menu

**Files:**

- Modify: `wework/src/components/layout/workspace-panels/BottomWorkspacePanel.tsx:1-269`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx:1-160,6930-7375`

- [ ] **Step 1: Add a mutable cloud-desktop mock to the workbench test**

Add before importing `ActualDesktopWorkbenchLayout`:

```tsx
const cloudDesktopExtensionMock = vi.hoisted(() => ({
  available: false,
  DeviceAction: () => null,
  WorkspaceAction: () => null,
  isInternalPageUrl: vi.fn(() => false),
  open: vi.fn(),
}))

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
}))
```

Reset it in the existing `beforeEach`:

```tsx
cloudDesktopExtensionMock.available = false
cloudDesktopExtensionMock.open.mockResolvedValue(true)
```

- [ ] **Step 2: Write failing integrated menu tests**

Use the existing `renderWorkspacePanelLayout`, `startTerminalSessionMock`, `startCodeServerSessionMock`, `openExternalUrlMock`, and cloud project fixture:

```tsx
test('shows Terminal, IDE, and Desktop in the bottom add menu', async () => {
  cloudDesktopExtensionMock.available = true
  renderWorkspacePanelLayout()

  await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

  await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

  const menu = await screen.findByTestId('workspace-terminal-new-tab-menu')
  expect(within(menu).getByTestId('workspace-add-terminal-option')).toHaveTextContent('终端')
  expect(within(menu).getByTestId('workspace-add-ide-option')).toHaveTextContent('IDE')
  expect(within(menu).getByTestId('workspace-add-desktop-option')).toHaveTextContent('桌面')
})

test('keeps the terminal and panel while opening IDE and Desktop from the add menu', async () => {
  cloudDesktopExtensionMock.available = true
  renderWorkspacePanelLayout()

  await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
  await userEvent.click(screen.getByTestId('workspace-terminal-card'))
  await screen.findByTestId('remote-terminal')

  await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))
  await userEvent.click(screen.getByTestId('workspace-add-ide-option'))
  await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(12))
  expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/ide')
  expect(screen.getByTestId('remote-terminal')).toBeInTheDocument()
  expect(screen.getByTestId('bottom-workspace-panel')).toHaveAttribute('aria-hidden', 'false')

  await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))
  await userEvent.click(screen.getByTestId('workspace-add-desktop-option'))
  await waitFor(() => expect(cloudDesktopExtensionMock.open).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('remote-terminal')).toBeInTheDocument()
  expect(screen.getByTestId('bottom-workspace-panel')).toHaveAttribute('aria-hidden', 'false')
})
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "shows Terminal, IDE, and Desktop|keeps the terminal and panel"
```

Expected: FAIL because the menu has only Terminal and the bottom panel does not register child actions.

- [ ] **Step 4: Register menu actions per tab**

In `BottomWorkspacePanel.tsx`, import `Code2` and `Monitor` plus the shared action type. Add:

```tsx
const [menuActionsByTabId, setMenuActionsByTabId] = useState<
  Record<string, WorkspacePanelMenuActions | undefined>
>({})

const updateTabMenuActions = useCallback(
  (tabId: string, actions: WorkspacePanelMenuActions | null) => {
    setMenuActionsByTabId(current => {
      if (actions) return { ...current, [tabId]: actions }
      if (!current[tabId]) return current
      const next = { ...current }
      delete next[tabId]
      return next
    })
  },
  []
)
```

Extract the loop body into a small `BottomWorkspaceTabContent` component so it can create a stable callback with `useCallback`:

```tsx
const handleMenuActionsChange = useCallback(
  (actions: WorkspacePanelMenuActions | null) => onMenuActionsChange(tab.id, actions),
  [onMenuActionsChange, tab.id]
)
```

Pass it to `WorkspacePanelCards` as `onMenuActionsChange={handleMenuActionsChange}`.

- [ ] **Step 5: Build the capability-aware three-item menu**

Compute `activeMenuActions` from `activeTabId`. Replace the one-item array with:

```tsx
const menuItems = useMemo<WorkspaceAddMenuItem[]>(() => {
  if (!activeMenuActions) return []

  return [
    ...(activeMenuActions.terminal.visible
      ? [
          {
            id: 'terminal',
            testId: 'workspace-add-terminal-option',
            icon: SquareTerminal,
            label: t('workbench.terminal', '终端'),
            disabled: activeMenuActions.terminal.disabled,
            onSelect: openTerminalTab,
          },
        ]
      : []),
    ...(activeMenuActions.ide.visible
      ? [
          {
            id: 'ide',
            testId: 'workspace-add-ide-option',
            icon: Code2,
            label: t('workbench.ide', 'IDE'),
            disabled: activeMenuActions.ide.disabled,
            onSelect: activeMenuActions.ide.run,
          },
        ]
      : []),
    ...(activeMenuActions.desktop.visible
      ? [
          {
            id: 'desktop',
            testId: 'workspace-add-desktop-option',
            icon: Monitor,
            label: t('workbench.desktop', '桌面'),
            disabled: activeMenuActions.desktop.disabled,
            onSelect: activeMenuActions.desktop.run,
          },
        ]
      : []),
  ]
}, [activeMenuActions, openTerminalTab, t])
```

Wrap `openTerminalTab` in `useCallback` so the memo dependency is stable. Remove a closed tab's action entry in `closeTab`.

- [ ] **Step 6: Update the large layout add-menu regression**

Rename `opens the bottom workspace add menu without replacing the terminal` to `adds another terminal from the bottom workspace menu without replacing the first`. Explicitly click the initial Terminal card before opening the menu. Keep its tab-title, close-button, and two-terminal assertions; add assertions that the externally available fixture does not invent a Desktop item when the fallback extension is unavailable.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "bottom workspace|bottom add menu|another terminal|Terminal, IDE, and Desktop|keeps the terminal and panel"
```

Expected: PASS; the mutable internal-extension fixture sees all three items, the ordinary external state hides Desktop, and IDE/Desktop preserve the visible terminal and panel.

- [ ] **Step 8: Commit the menu integration**

```bash
git add wework/src/components/layout/workspace-panels/BottomWorkspacePanel.tsx wework/src/components/layout/DesktopWorkbenchLayout.test.tsx
git commit -m "feat(wework): add workspace tools to terminal menu"
```

## Task 4: Add real cloud-task E2E coverage

**Files:**

- Modify: `wework/e2e/desktop/task-flow.e2e.mjs:2626-2765`

- [ ] **Step 1: Add a reusable launcher assertion helper**

Add near `verifyCloudProjectFlow`:

```js
async function openBottomToolLauncher(control, screenshotName) {
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await control.command('waitFor', '[data-testid="workspace-tool-launcher"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('workspace-terminal-card'),
    'The bottom workspace panel did not show the Terminal launcher'
  )
  assert.ok(
    snapshot.testIds.includes('workspace-ide-card'),
    'The bottom workspace panel did not show the IDE launcher'
  )
  assert.ok(
    !snapshot.testIds.includes('remote-terminal'),
    'The bottom workspace panel launched a terminal before explicit selection'
  )
  await captureVerificationScreenshot(control, screenshotName)
}
```

- [ ] **Step 2: Cover a new cloud conversation**

Immediately after `cloud-04-conversation-ready.png`, add:

```js
await openBottomToolLauncher(control, 'cloud-04a-new-task-tool-launcher.png')
await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
```

This proves opening the panel before the first prompt does not create a terminal.

- [ ] **Step 3: Cover a historical cloud task and terminal restoration**

After clicking `taskRowTestId` and waiting for `CLOUD_COMPLETION_TEXT`, add:

```js
await openBottomToolLauncher(control, 'cloud-05a-history-tool-launcher.png')
await control.command('clickWhenEnabled', '[data-testid="workspace-terminal-card"]')
await control.command('waitFor', '[data-testid="remote-terminal"]', {
  timeoutMs: UI_TIMEOUT_MS,
})
await captureVerificationScreenshot(control, 'cloud-05b-history-terminal-open.png')

await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
await control.command('waitFor', '[data-testid="remote-terminal"]', {
  timeoutMs: UI_TIMEOUT_MS,
})
const restoredSnapshot = JSON.parse(await control.command('snapshot', 'body'))
assert.ok(
  !restoredSnapshot.testIds.includes('workspace-tool-launcher'),
  'The historical task did not restore its explicitly created terminal'
)
await captureVerificationScreenshot(control, 'cloud-05c-history-terminal-restored.png')
await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
```

- [ ] **Step 4: Run the cloud desktop E2E**

Run:

```bash
pnpm --filter wework e2e:desktop:cloud
```

Expected: exit 0 with `Wework desktop cloud-project E2E passed` and screenshots for the new-task launcher, historical-task launcher, opened terminal, and restored terminal under the printed evidence directory.

- [ ] **Step 5: Commit the E2E regression**

```bash
git add wework/e2e/desktop/task-flow.e2e.mjs
git commit -m "test(wework): cover explicit cloud terminal launch"
```

## Task 5: Full verification and real Tauri QA

**Files:**

- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Run focused component tests**

```bash
pnpm --filter wework test -- src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx
```

Expected: all selected Vitest tests pass with zero failures and no unhandled errors.

- [ ] **Step 2: Run formatting checks**

```bash
pnpm --filter wework exec prettier --check src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/workspace-panel-tools.ts src/components/layout/workspace-panels/BottomWorkspacePanel.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx e2e/desktop/task-flow.e2e.mjs
```

Expected: `All matched files use Prettier code style!`

- [ ] **Step 3: Run lint and type checking**

```bash
pnpm --filter wework exec eslint src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/workspace-panel-tools.ts src/components/layout/workspace-panels/BottomWorkspacePanel.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx e2e/desktop/task-flow.e2e.mjs
pnpm --filter wework typecheck
```

Expected: both commands exit 0 with no lint or TypeScript errors.

- [ ] **Step 4: Run the complete Wework test suite**

```bash
pnpm --filter wework test
```

Expected: all Vitest files pass.

- [ ] **Step 5: Execute the isolated real-Tauri QA plan**

Preconditions and environment:

- macOS desktop environment with the repository dependencies installed.
- No personal Wework window is used.
- The isolated session created by `ai:verify` owns its executor home and process group.
- Test data is one newly created workspace conversation and one completed conversation in the same project; the cloud E2E from Task 4 supplies the cloud-specific evidence.

Start and inspect the isolated session:

```bash
AI_VERIFY_START="$(pnpm --filter wework ai:verify start)"
AI_VERIFY_SESSION="$(printf '%s' "$AI_VERIFY_START" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(value.slice(value.indexOf('{'))).session))")"
pnpm --filter wework ai:verify snapshot --session "$AI_VERIFY_SESSION"
```

Use the returned session path without printing the session file. Execute these cases with `ai:verify click`, `wait-for`, and `capture`:

1. **New task primary path:** select the project/new conversation, click `toggle-bottom-workspace-panel-button`, wait for `workspace-tool-launcher`, and capture the launcher. Expected: no `remote-terminal` or `embedded-local-terminal` before an explicit Terminal click.
2. **Explicit Terminal:** click `workspace-terminal-card`, then wait for `[data-testid="embedded-local-terminal"], [data-testid="remote-terminal"]`. Expected: one terminal appears.
3. **Recovery/restoration:** close `close-bottom-workspace-panel-button`, reopen with `toggle-bottom-workspace-panel-button`, and wait for the same terminal selector. Expected: the launcher does not replace the created terminal.
4. **Add menu:** click `workspace-terminal-new-tab-button` and wait for `workspace-terminal-new-tab-menu`. Expected: Terminal and IDE are present; Desktop is present only when the internal extension is installed.
5. **External-build boundary:** confirm `workspace-add-desktop-option` is absent in the ordinary external build. Expected: Wework does not invent the internal Desktop capability. IDE's default-browser call and internal Desktop preservation remain covered by component tests so verification does not drive an external personal browser.

Capture the final normal state:

```bash
pnpm --filter wework ai:verify capture --session "$AI_VERIFY_SESSION" --output /tmp/wework-explicit-terminal-launch.png
```

Always clean up:

```bash
pnpm --filter wework ai:verify stop --session "$AI_VERIFY_SESSION"
```

Expected: every primary, boundary, error, and recovery assertion matches the design; the stop command removes the isolated session resources.

- [ ] **Step 6: Review the final diff against the specification**

```bash
git diff HEAD~4 --check
git diff HEAD~4 --stat
git status --short
```

Expected: no whitespace errors, only the planned Wework component/test/E2E files differ, and the worktree is clean after the planned commits.
