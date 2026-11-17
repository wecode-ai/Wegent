// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import {
  guardProjectSnapshotWrites,
  type ProjectSnapshotWriteGuard,
} from './projectSnapshotWriteGuard'

function createGuardedApi(canWrite = false) {
  const transport = {
    projects: { get: vi.fn(), update: vi.fn() },
    issues: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      reorder: vi.fn(),
      assign: vi.fn(),
    },
    comments: { create: vi.fn() },
  }
  let guard: ProjectSnapshotWriteGuard = {
    projectId: 'one',
    issueIds: new Set(['issue-one']),
    canWrite,
    message: 'Refresh project before changing stages',
    acceptProject: vi.fn(),
  }
  return {
    transport,
    api: guardProjectSnapshotWrites(transport as unknown as SharedWorkspaceApi, () => guard),
    getGuard: () => guard,
    setGuard: (next: ProjectSnapshotWriteGuard) => {
      guard = next
    },
  }
}

describe('project snapshot write guard', () => {
  it('blocks structural writes before transport when the selected project is stale', async () => {
    const { api, transport } = createGuardedApi()
    const writes = [
      () => api.projects.update('one', { version: 1, tags: ['new'] }),
      () => api.issues.create('one', { title: 'New issue' }),
      () =>
        api.issues.reorder('one', { parentId: null, status: 'pending', issueIds: ['issue-one'] }),
      () =>
        api.issues.assign('one', 'issue-one', {
          version: 1,
          assigneeType: 'user',
          assigneeId: '2',
        }),
      ...[
        { status: 'pending' },
        { tags: ['stage'] },
        { position: { beforeItemId: null } },
        { parentId: null },
        { assigneeUserId: null },
        { assigneeAgentId: null },
        { assigneeGroupId: null },
        { assigneeTeamId: null },
      ].map(input => () => api.issues.update('issue-one', { version: 1, ...input })),
    ]
    for (const write of writes) {
      await expect(write()).rejects.toThrow('Refresh project before changing stages')
    }
    expect(transport.projects.update).not.toHaveBeenCalled()
    expect(transport.issues.create).not.toHaveBeenCalled()
    expect(transport.issues.update).not.toHaveBeenCalled()
    expect(transport.issues.reorder).not.toHaveBeenCalled()
    expect(transport.issues.assign).not.toHaveBeenCalled()
  })

  it('allows reads, comments, text edits and mutations for another project while stale', async () => {
    const { api, transport } = createGuardedApi()
    expect(api.projects.get).toBe(transport.projects.get)
    expect(api.issues.get).toBe(transport.issues.get)
    expect(api.comments).toBe(transport.comments)
    await api.issues.update('issue-one', {
      version: 1,
      title: 'Edited',
      description: 'Description',
    })
    await api.issues.update('other-issue', { version: 1, status: 'pending' })
    await api.projects.update('two', { version: 1, tags: [] })
    await api.issues.create('two', { title: 'Other issue' })
    await api.issues.reorder('two', { parentId: null, status: null, issueIds: [] })
    await api.issues.assign('two', 'other-issue', {
      version: 1,
      assigneeType: 'user',
      assigneeId: '2',
    })
    expect(transport.issues.update).toHaveBeenCalledTimes(2)
    expect(transport.projects.update).toHaveBeenCalledOnce()
    expect(transport.issues.create).toHaveBeenCalledOnce()
    expect(transport.issues.reorder).toHaveBeenCalledOnce()
    expect(transport.issues.assign).toHaveBeenCalledOnce()
  })

  it('reads the current guard for every call and accepts the mutation response immediately', async () => {
    const { api, transport, getGuard, setGuard } = createGuardedApi()
    await expect(
      api.issues.update('issue-one', { version: 1, status: 'pending' })
    ).rejects.toThrow()
    setGuard({ ...getGuard(), canWrite: true })
    await api.issues.update('issue-one', { version: 1, status: 'pending' })
    expect(transport.issues.update).toHaveBeenCalledOnce()
    const project = { id: 'one', version: 2, tags: ['new'] } as CollaborationProject
    transport.projects.update.mockResolvedValue(project)
    await expect(api.projects.update('one', { version: 1, tags: ['new'] })).resolves.toBe(project)
    expect(getGuard().acceptProject).toHaveBeenCalledExactlyOnceWith(project)

    const failure = Object.assign(new Error('Invalid board configuration'), { status: 422 })
    transport.projects.update.mockRejectedValue(failure)
    await expect(api.projects.update('one', { version: 2, tags: [] })).rejects.toBe(failure)
    expect(getGuard().acceptProject).toHaveBeenCalledOnce()
  })

  it('does not accept a late project mutation into another selected project', async () => {
    const { api, transport, getGuard, setGuard } = createGuardedApi(true)
    let resolve!: (project: CollaborationProject) => void
    transport.projects.update.mockReturnValue(
      new Promise<CollaborationProject>(done => (resolve = done))
    )
    const pending = api.projects.update('one', { version: 1, tags: [] })
    setGuard({ ...getGuard(), projectId: 'two' })
    resolve({ id: 'one', version: 2 } as CollaborationProject)
    await pending
    expect(getGuard().acceptProject).not.toHaveBeenCalled()
  })

  it('does not guard cloud issues when there is no selected cloud project', async () => {
    const { api, transport, getGuard, setGuard } = createGuardedApi()
    setGuard({ ...getGuard(), projectId: null })
    await api.issues.update('issue-one', { version: 1, status: 'pending' })
    expect(transport.issues.update).toHaveBeenCalledOnce()
  })
})
