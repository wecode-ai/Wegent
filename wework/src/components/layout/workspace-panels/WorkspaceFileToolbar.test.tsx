import { getPreferredWorkspaceOpener } from '@/lib/workspace-opener-preferences'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { workspaceFileBreadcrumbs } from './workspaceFileBreadcrumbModel'
import { WorkspaceFileToolbar } from './WorkspaceFileToolbar'

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

test('the opener menus put the last selected installed editor first across remounts', async () => {
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

  cleanup()
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  const menu = await screen.findByTestId('workspace-file-open-file-picker-menu')
  await waitFor(() =>
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.dataset.testid)
    ).toEqual([
      'workspace-file-open-file-option-Cursor',
      'workspace-file-open-file-option-VS Code',
      'workspace-file-reveal-location-button',
    ])
  )
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.contextMenu(screen.getByTestId('workspace-file-path'))
  expect(await screen.findByTestId('workspace-file-open-preferred')).toHaveTextContent('Cursor')
  fireEvent.pointerEnter(screen.getByTestId('workspace-file-open-with'))
  const submenu = await screen.findByTestId('workspace-file-open-with-submenu')
  expect(
    within(submenu)
      .getAllByRole('menuitem')
      .map(item => item.dataset.testid)
  ).toEqual(['workspace-file-open-file-option-Cursor', 'workspace-file-open-file-option-VS Code'])
  fireEvent.click(within(submenu).getByTestId('workspace-file-open-file-option-VS Code'))
  await waitFor(() => expect(getPreferredWorkspaceOpener(target.path)).toBe('vscode'))
  expect(mocks.openRequest).toHaveBeenLastCalledWith({ path: file.path, opener: 'vscode' })
})

test('an unavailable preferred editor stays hidden and the main button opens an available editor', async () => {
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.click(await screen.findByTestId('workspace-file-open-file-option-Cursor'))
  await waitFor(() => expect(getPreferredWorkspaceOpener(target.path)).toBe('cursor'))
  cleanup()
  mocks.applications.mockResolvedValue([
    { id: 'vscode', label: 'VS Code', available: true },
    { id: 'cursor', label: 'Cursor', available: false },
  ])
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  await screen.findByTestId('workspace-file-open-file-option-VS Code')
  expect(screen.queryByTestId('workspace-file-open-file-option-Cursor')).not.toBeInTheDocument()
  expect(getPreferredWorkspaceOpener(target.path)).toBe('cursor')
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.click(screen.getByTestId('workspace-file-open-file-button'))
  await waitFor(() => expect(getPreferredWorkspaceOpener(target.path)).toBe('vscode'))
  expect(mocks.openRequest).toHaveBeenLastCalledWith({ path: file.path, opener: 'vscode' })
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
  ['//server/share/src/a.ts', '//server/share', ['share', 'src', 'a.ts'], '//server/share/src'],
  ['/src/a.ts', '/', ['/', 'src', 'a.ts'], '/src'],
])('builds breadcrumb parents for %s', (path, root, labels, parent) => {
  const { crumbs } = workspaceFileBreadcrumbs(path, root, false)
  expect(crumbs.map(crumb => crumb.label)).toEqual(labels)
  expect(crumbs.at(-1)?.directoryPath).toBe(parent)
  expect(crumbs[0].activePath).toBeNull()
})

test('failed actions show an error without dispatching a file save', async () => {
  setup()
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.click(await screen.findByTestId('workspace-file-open-file-option-Cursor'))
  await waitFor(() => expect(getPreferredWorkspaceOpener(target.path)).toBe('cursor'))
  mocks.openRequest.mockRejectedValue(new Error('Open failed'))
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  fireEvent.click(await screen.findByTestId('workspace-file-open-file-option-VS Code'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Open failed')
  expect(getPreferredWorkspaceOpener(target.path)).toBe('cursor')
  fireEvent.click(screen.getByTestId('workspace-file-open-file-picker-button'))
  const menu = await screen.findByTestId('workspace-file-open-file-picker-menu')
  expect(within(menu).getAllByRole('menuitem')[0]).toHaveTextContent('Cursor')
  expect(mocks.invoke).not.toHaveBeenCalledWith('workspace.saveFileAs', expect.anything())
})
