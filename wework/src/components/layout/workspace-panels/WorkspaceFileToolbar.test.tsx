import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { WorkspaceFileToolbar } from './WorkspaceFileToolbar'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { workspaceFileBreadcrumbs } from './workspaceFileBreadcrumbModel'
import { getPreferredWorkspaceOpener } from '@/lib/workspace-opener-preferences'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  list: vi.fn(),
  copy: vi.fn(),
  openRequest: vi.fn(),
  applications: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: mocks.invoke }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('@/lib/runtime-environment', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { app?: string }) => (options?.app ? `${key}: ${options.app}` : key),
  }),
}))

const target: WorkspaceTarget = {
  deviceId: 'fixture-device',
  path: '/fixture/repo',
  source: 'runtime',
  workspaceSource: 'local',
}
const file = { path: '/fixture/repo/a.ts', name: 'a.ts', isDirectory: false, size: 12 }
const sibling = { ...file, path: '/fixture/repo/b.ts', name: 'b.ts' }
const directory = { path: '/fixture/repo/src', name: 'src', isDirectory: true, size: 0 }

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  mocks.applications.mockResolvedValue([
    { id: 'vscode', label: 'VS Code', available: true },
    { id: 'cursor', label: 'Cursor', available: true },
    { id: 'sublime-text', label: 'Sublime Text', available: false },
    { id: 'file-manager', label: 'Finder', available: true },
  ])
  mocks.invoke.mockImplementation(async (capability: string, params: unknown) => {
    if (capability === 'workspace.listOpeners') return mocks.applications()
    if (capability === 'workspace.openFile') return mocks.openRequest(params)
    return null
  })
  mocks.list.mockResolvedValue({ path: target.path, entries: [file, sibling] })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 20,
    left: 100,
    top: 20,
    right: 320,
    bottom: 48,
    width: 220,
    height: 28,
    toJSON: () => ({}),
  })
})

function setup(remote = false, textContent: string | undefined = 'edited contents') {
  const onSelect = vi.fn()
  render(
    <WorkspaceFileToolbar
      key={file.path}
      path={file.path}
      isDirectory={false}
      target={{ ...target, workspaceSource: remote ? 'remote' : 'local' }}
      api={{ listWorkspaceEntries: mocks.list, readWorkspaceTextFile: vi.fn() }}
      canCopyContents
      textContent={textContent}
      onSelect={onSelect}
    >
      {null}
    </WorkspaceFileToolbar>
  )
  return onSelect
}

function setupPath(path: string, isDirectory = false) {
  const onSelect = vi.fn()
  render(
    <WorkspaceFileToolbar
      key={path}
      path={path}
      isDirectory={isDirectory}
      target={target}
      api={{ listWorkspaceEntries: mocks.list, readWorkspaceTextFile: vi.fn() }}
      canCopyContents={!isDirectory}
      textContent={isDirectory ? undefined : 'edited contents'}
      onSelect={onSelect}
    >
      {null}
    </WorkspaceFileToolbar>
  )
  return onSelect
}

async function treeRow(path: string) {
  const tree = await screen.findByTestId('workspace-file-picker-tree')
  return waitFor(() => {
    const row = Array.from(
      tree.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? []
    ).find(item => item.dataset.itemPath === path)
    expect(row).toBeDefined()
    return row!
  })
}

test('left click lists siblings through the owning device and selects a file', async () => {
  const onSelect = setup()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  fireEvent.click(await treeRow('b.ts'))
  expect(mocks.list).toHaveBeenCalledWith('fixture-device', '/fixture/repo', '/fixture/repo')
  expect(onSelect).toHaveBeenCalledWith(sibling)
  expect(screen.queryByTestId('workspace-file-siblings-menu')).not.toBeInTheDocument()
})

test('the dropdown keeps type-colored icons and primary text for unselected entries', async () => {
  mocks.list.mockResolvedValue({
    path: target.path,
    entries: [file, { ...sibling, name: 'api.py', path: '/fixture/repo/api.py' }],
  })
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  const row = await treeRow('api.py')
  const shadow = screen.getByTestId('workspace-file-picker-tree').shadowRoot!
  expect(shadow.querySelector('[data-file-tree-colored-icons="true"]')).not.toBeNull()
  expect(row.querySelector('[data-icon-token="python"]')).not.toBeNull()
  const css = shadow.querySelector('[data-file-tree-unsafe-css]')!.textContent!
  expect(css).toContain('--trees-fg-override: rgb(var(--color-text-primary))')
  expect(css).toContain('color: var(--trees-fg)')
  expect(css).not.toMatch(/--trees-(?:file-icon-color|icon-blue)\s*:/)
  expect(css).not.toContain('--color-text-secondary')
})

test('right click exposes the file actions and copies the currently displayed text', async () => {
  setup()
  await waitFor(() => expect(mocks.applications).toHaveBeenCalled())
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-open-with')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-github')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-copy-contents'))
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('edited contents'))
})

test('right click menu closes on outside pointer down', async () => {
  setup()
  await waitFor(() => expect(mocks.applications).toHaveBeenCalled())
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()

  fireEvent.pointerDown(document.body)

  await waitFor(() =>
    expect(screen.queryByTestId('workspace-file-context-menu')).not.toBeInTheDocument()
  )
})

test('right click exposes folder actions without file-only commands', async () => {
  setupPath(directory.path, true)
  await waitFor(() => expect(mocks.applications).toHaveBeenCalled())
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-open-preferred')).toHaveTextContent('VS Code')
  expect(screen.getByTestId('workspace-file-open-with')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-copy-path')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-reveal-location-button')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-save-as')).not.toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-copy-contents')).not.toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-github')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-open-preferred'))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('workspace.openFile', {
      path: directory.path,
      opener: 'vscode',
    })
  )
})

test('right click on a breadcrumb folder opens the folder context menu', async () => {
  setupPath('/fixture/repo/src/a.ts')
  await waitFor(() => expect(mocks.applications).toHaveBeenCalled())
  fireEvent.contextMenu(screen.getByTestId('workspace-file-breadcrumb-/fixture/repo/src'), {
    clientX: 100,
    clientY: 40,
  })
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-file-open-with')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-copy-contents')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-open-preferred'))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('workspace.openFile', {
      path: directory.path,
      opener: 'vscode',
    })
  )
})

test('shows a GitHub action when the host returns a legacy source URL string', async () => {
  mocks.invoke.mockImplementation(async (capability: string, params: unknown) => {
    if (capability === 'workspace.listOpeners') return mocks.applications()
    if (capability === 'workspace.fileGitHubUrl')
      return 'https://github.com/team/repo/blob/main/a.ts'
    if (capability === 'shell.openExternal') return mocks.openRequest(params)
    return null
  })
  setup()
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  const github = await screen.findByTestId('workspace-file-github')
  expect(github).toHaveTextContent('workbench.workspace_file_github')
  fireEvent.click(github)
  await waitFor(() =>
    expect(mocks.openRequest).toHaveBeenCalledWith({
      url: 'https://github.com/team/repo/blob/main/a.ts',
    })
  )
})

test('shows a GitLab action when the host returns a GitLab source target', async () => {
  mocks.invoke.mockImplementation(async (capability: string, params: unknown) => {
    if (capability === 'workspace.listOpeners') return mocks.applications()
    if (capability === 'workspace.fileGitHubUrl')
      return { provider: 'gitlab', url: 'https://gitlab.test/team/repo/-/blob/main/a.ts' }
    if (capability === 'shell.openExternal') return mocks.openRequest(params)
    return null
  })
  setup()
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  const gitlab = await screen.findByTestId('workspace-file-github')
  expect(gitlab).toHaveTextContent('workbench.workspace_file_gitlab')
  fireEvent.click(gitlab)
  await waitFor(() =>
    expect(mocks.openRequest).toHaveBeenCalledWith({
      url: 'https://gitlab.test/team/repo/-/blob/main/a.ts',
    })
  )
})

test('shows a generic Git action when the host returns a Git repository target', async () => {
  mocks.invoke.mockImplementation(async (capability: string, params: unknown) => {
    if (capability === 'workspace.listOpeners') return mocks.applications()
    if (capability === 'workspace.fileGitHubUrl')
      return { provider: 'git', url: 'https://host/group/repo' }
    if (capability === 'shell.openExternal') return mocks.openRequest(params)
    return null
  })
  setup()
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  const git = await screen.findByTestId('workspace-file-github')
  expect(git).toHaveTextContent('workbench.workspace_file_git')
  fireEvent.click(git)
  await waitFor(() =>
    expect(mocks.openRequest).toHaveBeenCalledWith({
      url: 'https://host/group/repo',
    })
  )
})

test('the opener menu uses Electron capabilities and remembers the selected installed editor', async () => {
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  const cursor = await screen.findByTestId('workspace-file-open-file-option-Cursor')
  expect(
    screen.queryByTestId('workspace-file-open-file-option-Sublime Text')
  ).not.toBeInTheDocument()
  fireEvent.click(cursor)
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('workspace.openFile', {
      path: file.path,
      opener: 'cursor',
    })
  )
  expect(mocks.invoke).toHaveBeenCalledWith('workspace.listOpeners')
  await waitFor(() => expect(getPreferredWorkspaceOpener(target.path)).toBe('cursor'))
  fireEvent.click(screen.getByTestId('workspace-file-open-file-button'))
  await waitFor(() => expect(mocks.openRequest).toHaveBeenCalledTimes(2))
  expect(mocks.openRequest).toHaveBeenLastCalledWith({ path: file.path, opener: 'cursor' })
})

test('the context menu shows the preferred editor icon and an actionable open-with submenu', async () => {
  setup()
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  const preferred = await screen.findByTestId('workspace-file-open-preferred')
  expect(preferred).toHaveTextContent('VS Code')
  expect(preferred.querySelector('[data-testid="local-workspace-vscode-mark"]')).not.toBeNull()
  expect(preferred).toHaveClass('h-8')
  expect(preferred).not.toHaveClass('!h-6')
  const openWith = screen.getByTestId('workspace-file-open-with')
  expect(openWith).toHaveAttribute('aria-haspopup', 'menu')
  fireEvent.pointerEnter(openWith)
  expect(await screen.findByTestId('workspace-file-open-with-submenu')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-option-VS Code'))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('workspace.openFile', {
      path: file.path,
      opener: 'vscode',
    })
  )
})

test('no installed editors does not produce an empty open-with command', async () => {
  mocks.applications.mockResolvedValue([])
  setup()
  await waitFor(() =>
    expect(screen.getByTestId('workspace-file-open-file-button')).not.toBeDisabled()
  )
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'))
  expect(await screen.findByTestId('workspace-file-context-menu')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-open-preferred')).not.toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-open-with')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-button'))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('shell.openPath', { path: file.path })
  )
})

test('a sibling context menu acts on that sibling, not the previewed file', async () => {
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  const row = await treeRow('b.ts')
  fireEvent.contextMenu(row, { clientX: 120, clientY: 80, composed: true })
  const copy = await screen.findByTestId('workspace-file-copy-contents')
  fireEvent.pointerDown(copy)
  fireEvent.click(copy)
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('workspace.copyFileContents', { path: sibling.path })
  )
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(screen.getByTestId('workspace-file-siblings-menu')).toBeInTheDocument()
})

test('ancestor dropdown expands directories in place and allows repeated file switching', async () => {
  const folder = { path: '/fixture/repo/src', name: 'src', isDirectory: true, size: 0 }
  const first = { ...file, path: `${folder.path}/a.ts` }
  const second = { ...sibling, path: `${folder.path}/b.ts` }
  mocks.list.mockImplementation(async (_device: string, path: string) => ({
    path,
    entries: path === target.path ? [folder, file] : [first, second],
  }))
  const selected = vi.fn()
  function Preview() {
    const [path, setPath] = useState(first.path)
    return (
      <WorkspaceFileToolbar
        key={path}
        path={path}
        isDirectory={false}
        target={target}
        api={{ listWorkspaceEntries: mocks.list, readWorkspaceTextFile: vi.fn() }}
        canCopyContents
        onSelect={entry => {
          selected(entry)
          setPath(entry.path)
        }}
      >
        {null}
      </WorkspaceFileToolbar>
    )
  }
  render(<Preview />)
  expect(screen.getByTestId('workspace-file-path').textContent).toBe(first.path)
  fireEvent.click(screen.getByTestId('workspace-file-breadcrumb-/fixture/repo/src'))
  await treeRow('src/a.ts')
  expect(mocks.list).toHaveBeenCalledWith(target.deviceId, target.path, target.path)
  expect(mocks.list).toHaveBeenCalledWith(target.deviceId, folder.path, target.path)
  expect(selected).not.toHaveBeenCalled()
  fireEvent.click(await treeRow('src/'))
  await waitFor(() =>
    expect(
      screen
        .getByTestId('workspace-file-picker-tree')
        .shadowRoot?.querySelector('[data-item-path="src/a.ts"]')
    ).toBeNull()
  )
  expect(screen.getByTestId('workspace-file-directory-menu')).toBeInTheDocument()
  fireEvent.click(await treeRow('src/'))
  fireEvent.click(await treeRow('src/b.ts'))
  expect(selected).toHaveBeenLastCalledWith(second)
  expect(screen.getByTestId('workspace-file-name-button')).toHaveTextContent('b.ts')
  expect(screen.queryByTestId('workspace-file-directory-menu')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  const current = await treeRow('b.ts')
  expect(current).toHaveAttribute('data-item-selected', 'true')
  fireEvent.click(await treeRow('a.ts'))
  expect(selected).toHaveBeenLastCalledWith(first)
  expect(screen.getByTestId('workspace-file-path').textContent).toBe(first.path)
})

test('failed directory loading can be retried inside the dropdown', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Directory unavailable'))
  const onSelect = setup()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Directory unavailable')
  fireEvent.click(screen.getByTestId('workspace-file-siblings-retry'))
  fireEvent.click(await treeRow('b.ts'))
  expect(onSelect).toHaveBeenCalledWith(sibling)
})

test('late directory results do not reopen a collapsed folder', async () => {
  const folder = { path: '/fixture/repo/src', name: 'src', isDirectory: true, size: 0 }
  const nested = { ...file, path: `${folder.path}/a.ts` }
  let resolve!: (value: { entries: (typeof nested)[] }) => void
  const pending = new Promise<{ entries: (typeof nested)[] }>(done => {
    resolve = done
  })
  mocks.list.mockImplementation((_device: string, path: string) =>
    path === target.path ? Promise.resolve({ entries: [folder, file] }) : pending
  )
  const onSelect = setup()
  fireEvent.click(screen.getByTestId('workspace-file-name-button'))
  fireEvent.click(await treeRow('src/'))
  await waitFor(() =>
    expect(mocks.list).toHaveBeenCalledWith(target.deviceId, folder.path, target.path)
  )
  fireEvent.click(await treeRow('src/'))
  resolve({ entries: [nested] })
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(
    screen
      .getByTestId('workspace-file-picker-tree')
      .shadowRoot?.querySelector('[data-item-path="src/a.ts"]')
  ).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(await treeRow('src/'))
  fireEvent.click(await treeRow('src/a.ts'))
  expect(onSelect).toHaveBeenCalledWith(nested)
  expect(mocks.list).toHaveBeenCalledTimes(2)
})

test.each([
  ['/fixture/repo/src/a.ts', '/fixture/repo', ['repo', 'src', 'a.ts'], '/fixture/repo/src'],
  [
    'C:\\fixture\\repo\\src\\a.ts',
    'c:\\fixture\\repo',
    ['repo', 'src', 'a.ts'],
    'C:/fixture/repo/src',
  ],
  ['//server/share/src/a.ts', '//server/share', ['share', 'src', 'a.ts'], '//server/share/src'],
  ['/src/a.ts', '/', ['/', 'src', 'a.ts'], '/src'],
  ['C:/src/a.ts', 'C:/', ['C:/', 'src', 'a.ts'], 'C:/src'],
  ['/external/a.ts', '/fixture/repo', ['/', 'external', 'a.ts'], '/external'],
])('builds breadcrumb parents for %s', (path, root, labels, parent) => {
  const { crumbs } = workspaceFileBreadcrumbs(path, root, false)
  expect(crumbs.map(crumb => crumb.label)).toEqual(labels)
  expect(crumbs.at(-1)?.directoryPath).toBe(parent)
  expect(crumbs[0].activePath).toBeNull()
})

test('remote paths never invoke local file actions', async () => {
  setup(true)
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'), { clientX: 100, clientY: 40 })
  expect(await screen.findByTestId('workspace-file-copy-path')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-open-with')).not.toBeInTheDocument()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(mocks.applications).not.toHaveBeenCalled()
})

test('failed actions show an error without dispatching a file save', async () => {
  mocks.openRequest.mockRejectedValue(new Error('Open failed'))
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.click(await screen.findByTestId('workspace-file-open-file-option-VS Code'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Open failed')
  expect(mocks.invoke).not.toHaveBeenCalledWith('workspace.saveFileAs', expect.anything())
})
