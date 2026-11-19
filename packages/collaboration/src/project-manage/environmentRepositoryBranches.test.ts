import { expect, test, vi } from 'vitest'
import type { WorkspaceGitRepository, WorkspaceGitBranch } from '../ports/SharedWorkspaceApi'
import {
  createEnvironmentRepositoryBranches,
  type RepositoryDraft,
  type RepositoryDefaults,
} from './environmentRepositoryBranches'
import { repositoryKey } from './environmentConfiguration'

const repository: WorkspaceGitRepository = {
  id: 1,
  name: 'repo',
  fullName: 'org/repo',
  cloneUrl: 'https://git.example/org/repo',
  provider: 'gitlab',
  gitDomain: 'git.example',
}
function deferred() {
  let resolve!: (value: WorkspaceGitBranch[]) => void
  const promise = new Promise<WorkspaceGitBranch[]>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function fixture() {
  let drafts: RepositoryDraft[] = [
    { id: 'row', name: 'repo', url: repository.cloneUrl, path: 'repo', ref: '', primary: true },
  ]
  const defaults: RepositoryDefaults = new Map()
  const listBranches = vi.fn().mockResolvedValue([{ name: 'main', default: true }])
  const pool = createEnvironmentRepositoryBranches(
    { list: vi.fn(), listBranches },
    change => {
      drafts = change(drafts)
    },
    defaults
  )
  return {
    pool,
    listBranches,
    defaults,
    drafts: () => drafts,
    edit: (patch: Partial<RepositoryDraft>) => {
      drafts = drafts.map(draft => ({ ...draft, ...patch }))
    },
  }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

test('only observed repositories load, duplicate rows share one read, and ready cache is reusable', async () => {
  const f = fixture(),
    observation = f.pool.observe([repository, repository])
  expect(f.listBranches).not.toHaveBeenCalled()
  const stop = observation.subscribe(vi.fn())
  await settle()
  expect(f.listBranches).toHaveBeenCalledTimes(1)
  expect(observation.getSnapshot()[repositoryKey(repository)]).toMatchObject({ status: 'ready' })
  expect(f.drafts()[0].ref).toBe('main')
  stop()
  const stopAgain = f.pool.observe([repository]).subscribe(vi.fn())
  expect(f.listBranches).toHaveBeenCalledTimes(1)
  stopAgain()
})

test('a manual ref edited during loading is never replaced by a default branch', async () => {
  const f = fixture(),
    pending = deferred()
  f.listBranches.mockReturnValueOnce(pending.promise)
  const stop = f.pool.observe([repository]).subscribe(vi.fn())
  f.edit({ ref: 'release/custom' })
  pending.resolve([{ name: 'main', default: true }])
  await settle()
  expect(f.drafts()[0].ref).toBe('release/custom')
  stop()
})

test('detaching ignores late branch responses and cannot mutate the editor draft', async () => {
  const f = fixture(),
    pending = deferred()
  f.listBranches.mockReturnValueOnce(pending.promise)
  const stop = f.pool.observe([repository]).subscribe(vi.fn())
  stop()
  pending.resolve([{ name: 'stale', default: true }])
  await settle()
  expect(f.drafts()[0].ref).toBe('')
  expect(f.defaults.size).toBe(0)
})

test('failed branch reads stay failed until retry and refresh only auto-derived refs', async () => {
  const f = fixture(),
    observation = f.pool.observe([repository])
  f.listBranches.mockRejectedValueOnce(new Error('Offline'))
  const stop = observation.subscribe(vi.fn())
  await settle()
  expect(observation.getSnapshot()[repositoryKey(repository)].status).toBe('error')
  expect(f.listBranches).toHaveBeenCalledTimes(1)
  await f.pool.retry(repository)
  expect(f.drafts()[0].ref).toBe('main')
  f.listBranches.mockResolvedValueOnce([{ name: 'next-default', default: true }])
  await f.pool.retry(repository)
  expect(f.drafts()[0].ref).toBe('next-default')
  stop()
})

test('no catalog capability causes no reads and no branch state', () => {
  const pool = createEnvironmentRepositoryBranches(undefined, vi.fn(), new Map())
  const observation = pool.observe([repository])
  const stop = observation.subscribe(vi.fn())
  expect(observation.getSnapshot()).toEqual({})
  stop()
})
