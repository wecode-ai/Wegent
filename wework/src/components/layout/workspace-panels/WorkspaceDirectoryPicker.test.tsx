import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkspaceFileApi, WorkspaceFileEntry, WorkspaceTarget } from '@/types/workspace-files'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const target: WorkspaceTarget = {
  deviceId: 'device-1',
  path: '/repo',
  source: 'runtime',
  workspaceSource: 'local',
}
function file(name: string): WorkspaceFileEntry {
  return { name, path: '/repo/' + name, size: 1, isDirectory: false }
}
function props(api: WorkspaceFileApi) {
  return {
    api,
    target,
    directoryPath: '/repo',
    activePath: null,
    expandActive: false,
    onSelect: vi.fn(),
    onPathContextMenu: vi.fn(),
  }
}
const fileTree = () => within(screen.getByRole('tree', { name: '/repo' }))

test('isolates a late root read when a different API serves the same workspace path', async () => {
  let finish!: (value: { entries: WorkspaceFileEntry[]; path: string }) => void
  const oldApi = {
    listWorkspaceEntries: vi.fn(
      () =>
        new Promise<{ entries: WorkspaceFileEntry[]; path: string }>(resolve => {
          finish = resolve
        })
    ),
  } as unknown as WorkspaceFileApi
  const newApi = {
    listWorkspaceEntries: vi.fn(async () => ({ path: '/repo', entries: [file('new.ts')] })),
  } as unknown as WorkspaceFileApi
  const { rerender, unmount } = render(<WorkspaceDirectoryPicker {...props(oldApi)} />)
  expect(oldApi.listWorkspaceEntries).toHaveBeenCalledExactlyOnceWith('device-1', '/repo', '/repo')
  rerender(<WorkspaceDirectoryPicker {...props(newApi)} />)
  expect(await screen.findByRole('treeitem', { name: 'new.ts' })).toBeVisible()
  await act(async () => finish({ path: '/repo', entries: [file('old.ts')] }))
  expect(fileTree().queryByRole('treeitem', { name: 'old.ts' })).not.toBeInTheDocument()
  expect(fileTree().getByRole('treeitem', { name: 'new.ts' })).toBeVisible()
  expect(screen.queryByRole('status')).toBeNull()
  unmount()
})

test('requests the same root again for a different device and ignores a late failure from the old device', async () => {
  let fail!: (error: Error) => void
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    .mockResolvedValueOnce({ path: '/repo', entries: [file('device-two.ts')] })
  const api = { listWorkspaceEntries: list } as unknown as WorkspaceFileApi
  const initial = props(api)
  const { rerender, unmount } = render(<WorkspaceDirectoryPicker {...initial} />)
  rerender(<WorkspaceDirectoryPicker {...initial} target={{ ...target, deviceId: 'device-2' }} />)
  expect(await screen.findByRole('treeitem', { name: 'device-two.ts' })).toBeVisible()
  await act(async () => fail(new Error('Old device disconnected')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(fileTree().getByRole('treeitem', { name: 'device-two.ts' })).toBeVisible()
  expect(list).toHaveBeenNthCalledWith(2, 'device-2', '/repo', '/repo')
  unmount()
})
