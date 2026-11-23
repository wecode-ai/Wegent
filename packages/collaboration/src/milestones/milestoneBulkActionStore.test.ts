import { expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue } from '../types'
import { createMilestoneBulkActionStore } from './milestoneBulkActionStore'

const issue = { id: 'issue-one', version: 1, milestone_id: 'previous' } as CollaborationIssue

function fixture() {
  const update = vi.fn().mockResolvedValue({ ...issue, milestone_id: 'next' })
  const get = vi.fn().mockResolvedValue(issue)
  const api = { issues: { update, get } } as unknown as SharedWorkspaceApi
  const store = createMilestoneBulkActionStore(api)
  const unsubscribe = store.subscribe(vi.fn())
  const onUpdated = vi.fn()
  return { update, get, store, unsubscribe, onUpdated }
}

it('rejects a late batch result after the last subscriber leaves', async () => {
  const f = fixture()
  let finish!: (result: CollaborationIssue) => void
  f.update.mockReturnValueOnce(
    new Promise<CollaborationIssue>(accept => {
      finish = accept
    })
  )
  const pending = f.store.apply([issue], 'next', [], 'Failed', f.onUpdated)
  expect(f.store.getSnapshot().busy).toBe(true)
  f.unsubscribe()
  finish({ ...issue, milestone_id: 'next' })
  await pending
  expect(f.onUpdated).not.toHaveBeenCalled()
  expect(f.store.getSnapshot()).toMatchObject({ busy: false, failures: [] })
  expect(f.get).not.toHaveBeenCalled()
})

it('does not issue a retry mutation after its authority read loses the subscriber', async () => {
  const f = fixture()
  let finish!: (result: CollaborationIssue) => void
  f.get.mockReturnValueOnce(
    new Promise<CollaborationIssue>(accept => {
      finish = accept
    })
  )
  const pending = f.store.apply([issue], 'next', [issue.id], 'Failed', f.onUpdated)
  expect(f.get).toHaveBeenCalledWith(issue.id)
  f.unsubscribe()
  finish({ ...issue, version: 4 })
  await pending
  expect(f.update).not.toHaveBeenCalled()
  expect(f.onUpdated).not.toHaveBeenCalled()
  expect(f.get).toHaveBeenCalledOnce()
})

it('coalesces repeat clicks and retains a batch until its last subscriber leaves', async () => {
  const f = fixture()
  let finish!: (result: CollaborationIssue) => void
  f.update.mockReturnValueOnce(
    new Promise<CollaborationIssue>(accept => {
      finish = accept
    })
  )
  const other = f.store.subscribe(vi.fn())
  const pending = f.store.apply([issue], 'next', [], 'Failed', f.onUpdated)
  await f.store.apply([issue], 'next', [], 'Failed', f.onUpdated)
  expect(f.update).toHaveBeenCalledOnce()
  f.unsubscribe()
  const result = { ...issue, milestone_id: 'next' }
  finish(result)
  await pending
  expect(f.onUpdated).toHaveBeenCalledExactlyOnceWith(result)
  expect(f.store.getSnapshot().busy).toBe(false)
  other()
})
