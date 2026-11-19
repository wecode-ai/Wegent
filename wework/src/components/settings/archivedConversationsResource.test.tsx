import { useSyncExternalStore } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { LocalHarnessSessionDescriptor } from '@/lib/local-terminal'
import { createArchivedConversationsResource } from './archivedConversationsResource'
import { archivedItem, archivedItemAt } from './archivedConversations.testFixtures'
import { itemAddressKey } from './archivedConversationItems'
import {
  notifyArchivedBulkDeleteDeleted,
  reportArchivedCleanupFailure,
  resetArchivedConversationsSettingsStateForTest,
} from './archivedConversationsSettingsState'

const harness = vi.hoisted(() => vi.fn())
vi.mock('@/lib/local-terminal', () => ({ listArchivedLocalHarnessSessions: harness }))
function setup() {
  const list = vi.fn().mockResolvedValue({ items: [archivedItem] })
  const api = { listArchivedConversations: list } as unknown as NonNullable<
    WorkbenchServices['runtimeWorkApi']
  >
  const resource = createArchivedConversationsResource(api)
  return {
    list,
    resource,
    ...renderHook(() => useSyncExternalStore(resource.subscribe, resource.getSnapshot)),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const session: LocalHarnessSessionDescriptor = {
  session_id: 'harness',
  harness_id: 'opencode',
  title: 'Harness archive',
  cwd: '/test/project',
  created_at: 1786506000000,
  archived_at: 1786506100000,
  is_primary: false,
  project_id: null,
  active: false,
}
beforeEach(() => {
  resetArchivedConversationsSettingsStateForTest()
  harness.mockReset().mockResolvedValue([])
})

test('publishes runtime archives without waiting for the independent harness source', async () => {
  const pending = deferred<LocalHarnessSessionDescriptor[]>()
  harness.mockReturnValue(pending.promise)
  const { result } = setup()
  await waitFor(() => expect(result.current.items).toEqual([archivedItem]))
  expect(result.current.loading).toBe(true)
  await act(async () => pending.resolve([session]))
  expect(result.current.items.map(item => item.title)).toEqual(['Greet user', 'Harness archive'])
  expect(result.current.loading).toBe(false)
})

test('retains valid runtime rows when the harness read fails and recovers on retry', async () => {
  harness.mockRejectedValueOnce(new Error('Harness inventory failed'))
  const { result, resource } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.items).toEqual([archivedItem])
  expect(result.current.failure?.cause).toBeInstanceOf(Error)
  await act(async () => resource.reload())
  expect(result.current.failure).toBeNull()
})

test('keeps cached data on an all-source refresh failure rather than publishing an empty list', async () => {
  const { list, resource, result } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  list.mockRejectedValueOnce(new Error('Runtime unavailable'))
  harness.mockRejectedValueOnce(new Error('Harness unavailable'))
  await act(async () => resource.reload())
  expect(result.current.items).toEqual([archivedItem])
  expect(result.current.failure).not.toBeNull()
})

test('ignores a superseded load before it can change source caches', async () => {
  const { resource, result, list } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  const old = deferred<{ items: (typeof archivedItem)[] }>()
  list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [archivedItemAt(2)] })
  act(() => {
    void resource.reload()
  })
  await act(async () => resource.reload())
  await act(async () => old.resolve({ items: [archivedItem] }))
  expect(result.current.items).toEqual([archivedItemAt(2)])
})

test('does not resurrect globally deleted rows from a late read', async () => {
  const { resource, result, list } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  const old = deferred<{ items: (typeof archivedItem)[] }>()
  list.mockReturnValueOnce(old.promise)
  act(() => {
    void resource.reload()
    notifyArchivedBulkDeleteDeleted(new Set([itemAddressKey(archivedItem)]))
  })
  expect(result.current.items).toEqual([])
  await act(async () => old.resolve({ items: [archivedItem] }))
  expect(result.current.items).toEqual([])
})

test('uses full addresses for single-delete hiding and restores failed cleanup records', async () => {
  const other = { ...archivedItem, deviceId: 'other-device', title: 'Other device' }
  const { resource, result, list } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  list.mockResolvedValue({ items: [archivedItem, other] })
  await act(async () => resource.reload())
  act(() => resource.removeItem(archivedItem))
  expect(result.current.items).toEqual([other])
  act(() => reportArchivedCleanupFailure(itemAddressKey(archivedItem), 'Cleanup rejected'))
  await waitFor(() => expect(result.current.items).toEqual([archivedItem, other]))
})

test('does not let an older verification snapshot overwrite a newer list refresh', async () => {
  const { resource, result, list } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  const old = deferred<{ items: (typeof archivedItem)[] }>()
  list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [archivedItemAt(2)] })
  const verified = resource.fetchAll()
  await act(async () => resource.reload())
  await act(async () => {
    old.resolve({ items: [archivedItem] })
    const snapshot = await verified
    resource.applyVerifiedItems(snapshot.items, snapshot)
  })
  expect(result.current.items).toEqual([archivedItemAt(2)])
})

test('detaches cleanup subscriptions when the last reader closes', async () => {
  const { unmount, result, list } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  unmount()
  act(() => reportArchivedCleanupFailure(itemAddressKey(archivedItem), 'Late failure'))
  expect(list).toHaveBeenCalledTimes(1)
})
