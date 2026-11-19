import { expect, test, vi } from 'vitest'
import type { WorkspaceFileApi, WorkspaceFileEntry } from '@/types/workspace-files'
import { createWorkspaceDirectoryResource } from './workspaceDirectoryResource'

function entry(path: string): WorkspaceFileEntry {
  return { path, name: path.split('/').at(-1)!, size: 1, isDirectory: false }
}
function pending() {
  let resolve!: (result: { path: string; entries: WorkspaceFileEntry[] }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ path: string; entries: WorkspaceFileEntry[] }>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}

test('deduplicates reads while independent folder errors preserve the root catalog and retry clears only that error', async () => {
  const root = pending()
  const child = pending()
  const list = vi
    .fn()
    .mockReturnValueOnce(root.promise)
    .mockReturnValueOnce(child.promise)
    .mockResolvedValueOnce({ path: '/repo/src', entries: [entry('/repo/src/ready.ts')] })
  const resource = createWorkspaceDirectoryResource(
    { listWorkspaceEntries: list } as unknown as WorkspaceFileApi,
    'device',
    '/repo',
    '/repo'
  )
  const stop = resource.subscribe(vi.fn())
  await resource.load('/repo')
  expect(list).toHaveBeenCalledOnce()
  root.resolve({ path: '/repo', entries: [entry('/repo/README.md')] })
  await root.promise
  const childRead = resource.load('/repo/src')
  await resource.load('/repo/src')
  expect(list).toHaveBeenCalledTimes(2)
  child.reject(new Error('Folder denied'))
  await childRead
  expect(resource.getSnapshot().entries['/repo'][0].name).toBe('README.md')
  expect(resource.getSnapshot().errors).toEqual({ '/repo/src': 'Folder denied' })
  await resource.load('/repo/src', true)
  expect(resource.getSnapshot().errors).toEqual({})
  expect(resource.getSnapshot().entries['/repo/src'][0].name).toBe('ready.ts')
  expect(resource.getSnapshot().loading).toBe(0)
  stop()
})

test('restarts a detached pending read and rejects the obsolete completion', async () => {
  const old = pending()
  const fresh = pending()
  const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const resource = createWorkspaceDirectoryResource(
    { listWorkspaceEntries: list } as unknown as WorkspaceFileApi,
    'device',
    '/repo',
    '/repo'
  )
  const stop = resource.subscribe(vi.fn())
  expect(resource.getSnapshot().loading).toBe(1)
  stop()
  expect(resource.getSnapshot().loading).toBe(0)
  const stopFresh = resource.subscribe(vi.fn())
  fresh.resolve({ path: '/repo', entries: [entry('/repo/fresh.ts')] })
  await fresh.promise
  old.resolve({ path: '/repo', entries: [entry('/repo/old.ts')] })
  await old.promise
  expect(resource.getSnapshot().entries['/repo'][0].name).toBe('fresh.ts')
  expect(list).toHaveBeenCalledTimes(2)
  stopFresh()
})
