import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { archivedItem, archivedItemAt } from './archivedConversations.testFixtures'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import {
  getArchivedBulkDeleteProgress,
  resetArchivedConversationsSettingsStateForTest,
} from './archivedConversationsSettingsState'

const host = vi.hoisted(() => ({
  harness: vi.fn(),
  restoreHarness: vi.fn(),
  deleteHarness: vi.fn(),
  changed: vi.fn(),
}))
vi.mock('@/lib/local-terminal', () => ({
  listArchivedLocalHarnessSessions: host.harness,
  unarchiveLocalHarnessSession: host.restoreHarness,
  deleteArchivedLocalHarnessSession: host.deleteHarness,
  notifyLocalHarnessSessionsChanged: host.changed,
}))
function source(items = [archivedItem]) {
  const list = vi.fn().mockResolvedValue({ items, projectGroups: [], total: items.length })
  const restore = vi.fn().mockResolvedValue({ accepted: true, taskId: archivedItem.taskId })
  const remove = vi.fn().mockResolvedValue({ accepted: true, taskId: archivedItem.taskId })
  const bulk = vi.fn().mockResolvedValue({ results: [] })
  const api = {
    listArchivedConversations: list,
    unarchiveConversation: restore,
    deleteArchivedConversation: remove,
    deleteArchivedConversationsBulk: bulk,
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
  return { api, list, restore, remove, bulk }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  resetArchivedConversationsSettingsStateForTest()
  host.harness.mockReset().mockResolvedValue([])
})

test('keeps runtime records visible while another archive source is loading', async () => {
  const pending = deferred<[]>()
  host.harness.mockReturnValue(pending.promise)
  const current = source()
  render(<ArchivedConversationsSettingsPage api={current.api} />)
  expect(await screen.findByText('Greet user')).toBeInTheDocument()
  expect(screen.getByTestId('archived-loading')).toBeInTheDocument()
  expect(screen.getByTestId('archived-bulk-delete-button')).toBeDisabled()
  await act(async () => pending.resolve([]))
  await waitFor(() => expect(screen.getByTestId('archived-bulk-delete-button')).toBeEnabled())
  expect(screen.queryByTestId('archived-loading')).not.toBeInTheDocument()
})

test('closes an old delete confirmation and hides old records when the API owner changes', async () => {
  const old = source(),
    current = source([archivedItemAt(2)])
  const { rerender } = render(<ArchivedConversationsSettingsPage api={old.api} />)
  await screen.findByText('Greet user')
  fireEvent.click(screen.getByTestId('archived-delete-button-device-1-codex-1'))
  expect(screen.getByTestId('archived-delete-confirm-dialog')).toBeInTheDocument()
  rerender(<ArchivedConversationsSettingsPage api={current.api} />)
  expect(screen.queryByTestId('archived-delete-confirm-dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('Greet user')).not.toBeInTheDocument()
  await screen.findByText('Archived conversation 2')
  expect(old.remove).not.toHaveBeenCalled()
  expect(current.remove).not.toHaveBeenCalled()
})

test('keeps a refused single deletion visible and permits an explicit confirmation retry', async () => {
  const current = source()
  current.remove.mockResolvedValueOnce({ accepted: false, error: 'Deletion refused' })
  render(<ArchivedConversationsSettingsPage api={current.api} />)
  await screen.findByText('Greet user')
  fireEvent.click(screen.getByTestId('archived-delete-button-device-1-codex-1'))
  fireEvent.click(screen.getByTestId('archived-delete-confirm-dialog-confirm-button'))
  const dialog = screen.getByTestId('archived-delete-confirm-dialog')
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Deletion refused')
  expect(screen.getByText('Greet user')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('archived-delete-confirm-dialog-confirm-button'))
  await waitFor(() =>
    expect(screen.queryByTestId('archived-delete-confirm-dialog')).not.toBeInTheDocument()
  )
  expect(screen.queryByText('Greet user')).not.toBeInTheDocument()
  expect(current.remove).toHaveBeenCalledTimes(2)
})

test('does not report a refused restore as successful or refresh the sidebar', async () => {
  const current = source(),
    refresh = vi.fn()
  current.restore.mockResolvedValueOnce({ accepted: false, error: 'Restore refused' })
  render(<ArchivedConversationsSettingsPage api={current.api} onRefreshWorkLists={refresh} />)
  await screen.findByText('Greet user')
  fireEvent.click(screen.getByTestId('archived-unarchive-button-device-1-codex-1'))
  expect(await screen.findByTestId('archived-error')).toHaveTextContent('Restore refused')
  expect(screen.getByText('Greet user')).toBeInTheDocument()
  expect(screen.queryByTestId('archived-view-now-button')).not.toBeInTheDocument()
  expect(refresh).not.toHaveBeenCalled()
})

test('does not publish an old restore completion or refresh another API owner', async () => {
  const old = source(),
    current = source([archivedItemAt(2)]),
    refresh = vi.fn()
  const pending = deferred<{ accepted: boolean; taskId: string }>()
  old.restore.mockReturnValue(pending.promise)
  const { rerender } = render(
    <ArchivedConversationsSettingsPage api={old.api} onRefreshWorkLists={refresh} />
  )
  await screen.findByText('Greet user')
  fireEvent.click(screen.getByTestId('archived-unarchive-button-device-1-codex-1'))
  rerender(<ArchivedConversationsSettingsPage api={current.api} onRefreshWorkLists={refresh} />)
  await screen.findByText('Archived conversation 2')
  await act(async () => pending.resolve({ accepted: true, taskId: archivedItem.taskId }))
  expect(screen.queryByTestId('archived-view-now-button')).not.toBeInTheDocument()
  expect(refresh).not.toHaveBeenCalled()
})

test('releases foreground operation ownership after a failed view action', async () => {
  const current = source([archivedItem, archivedItemAt(2)])
  const open = vi.fn().mockRejectedValueOnce(new Error('Open failed'))
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(
    <ArchivedConversationsSettingsPage
      api={current.api}
      onRefreshWorkLists={refresh}
      onOpenRuntimeTask={open}
    />
  )
  await screen.findByText('Greet user')
  current.list.mockResolvedValueOnce({ items: [archivedItemAt(2)], projectGroups: [], total: 1 })
  fireEvent.click(screen.getByTestId('archived-unarchive-button-device-1-codex-1'))
  await screen.findByTestId('archived-view-now-button')
  fireEvent.click(screen.getByTestId('archived-view-now-button'))
  await waitFor(() => expect(screen.getByTestId('archived-error')).toHaveTextContent('Open failed'))
  current.list.mockResolvedValueOnce({ items: [], projectGroups: [], total: 0 })
  fireEvent.click(screen.getByTestId('archived-unarchive-button-device-1-codex-2'))
  await waitFor(() => expect(current.restore).toHaveBeenCalledTimes(2))
})

test('finishes a confirmed bulk deletion after the page closes', async () => {
  const current = source([archivedItem, archivedItemAt(2)])
  const pending = deferred<{ results: Array<{ taskId: string; deleted: boolean }> }>()
  current.bulk.mockReturnValueOnce(pending.promise)
  const { unmount } = render(<ArchivedConversationsSettingsPage api={current.api} />)
  await screen.findByText('Greet user')
  fireEvent.click(screen.getByTestId('archived-bulk-delete-button'))
  fireEvent.click(screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button'))
  expect(current.bulk).toHaveBeenCalledTimes(1)
  current.list.mockResolvedValue({ items: [], projectGroups: [], total: 0 })
  unmount()
  await act(async () =>
    pending.resolve({
      results: [
        { taskId: archivedItem.taskId, deleted: true },
        { taskId: 'codex-2', deleted: true },
      ],
    })
  )
  await waitFor(() => expect(getArchivedBulkDeleteProgress()?.running).toBe(false))
  expect(getArchivedBulkDeleteProgress()?.completed).toBe(2)
})
