import { expect, test, vi } from 'vitest'
import { ApiError, createHttpClient } from '@/api/http'
import { createPersonalIssuesApi, type IndependentIssue } from '@/api/personalIssues'
import type { IssueDetailResponse } from '@wegent/collaboration/platform'
import { createIndependentIssueDialogState } from './independentIssueDialogState'

const issue: IndependentIssue = {
  id: 'share-12-test',
  title: 'Shared issue',
  description: '',
  status: 'pending',
  priority: 'medium',
  creator_id: 12,
  assignee_id: null,
  version: 1,
  created_at: '',
  updated_at: '',
  metadata: { participants: [], archived: false, due_at: null },
  people: {},
}

function detailFor(row: IndependentIssue): IssueDetailResponse {
  return {
    id: row.id,
    cloud_project_id: '',
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    version: row.version,
    sequence_number: 0,
    parent_id: row.parent_id ?? null,
    created_by_user_id: row.creator_id,
    assignee_user_id: row.assignee_id,
    tags: [],
    sort_order: 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: null,
    due_at: row.metadata.due_at,
    edit_context: {
      participants: row.metadata.participants.map(user_id => ({
        user_id,
        user_name: row.people[user_id] ?? null,
        direct: (row.metadata.direct_participants ?? row.metadata.participants).includes(user_id),
      })),
      resources: row.metadata.resource_participants ?? [],
      archived: row.metadata.archived,
      has_shared_source: Boolean(row.metadata.share),
    },
  }
}

test.each([
  { status: 404, removed: true },
  { status: 403, removed: false },
])(
  'reconciles delete status $status without treating access loss as success',
  async ({ status, removed }) => {
    let finishDelete!: (reason: ApiError) => void
    const deletion = new Promise<never>((_, reject) => {
      finishDelete = reject
    })
    let finishReload!: (detail: IssueDetailResponse) => void
    const reload = new Promise<IssueDetailResponse>(resolve => {
      finishReload = resolve
    })
    const api = {
      ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
      issueDetail: vi.fn().mockResolvedValueOnce(detailFor(issue)).mockReturnValueOnce(reload),
      comments: vi.fn().mockResolvedValue([]),
      remove: vi.fn(() => deletion),
    }
    const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
    const onSaved = vi.fn()
    const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved })
    try {
      await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(issue))
      const remove = state.remove()
      state.retry()
      expect(state.getSnapshot().loading).toBe(true)
      finishDelete(new ApiError('Issue unavailable', status))
      expect(await remove).toBe(removed)
      finishReload(detailFor(issue))
      await reload
      expect(state.getSnapshot()).toMatchObject({
        issue: null,
        busy: false,
        loading: false,
        error: removed ? '' : 'Issue unavailable',
      })
      expect(onSaved.mock.calls).toEqual(removed ? [[null]] : [])
    } finally {
      unsubscribe()
    }
  }
)

test('a moved Issue opens the authorized project from the first detail response', async () => {
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi.fn().mockResolvedValue({ ...detailFor(issue), cloud_project_id: '12' }),
    comments: vi.fn().mockRejectedValue(new ApiError('Issue not found', 404)),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
  const onMovedToProject = vi.fn()
  const unsubscribe = state.subscribe(() => {}, {
    onClose: () => {},
    onSaved: () => {},
    onMovedToProject,
  })
  try {
    await vi.waitFor(() => expect(onMovedToProject).toHaveBeenCalledExactlyOnceWith('12', issue.id))
    expect(api.issueDetail).toHaveBeenCalledExactlyOnceWith(issue.id)
    expect(state.getSnapshot()).toMatchObject({ issue: null, loading: false, error: '' })
  } finally {
    unsubscribe()
  }
})

test('a shared detail patch saves content and status with the observed version', async () => {
  const latest: IndependentIssue = {
    ...issue,
    version: 2,
    metadata: { ...issue.metadata, participants: [20], direct_participants: [20] },
  }
  const updated: IndependentIssue = {
    ...latest,
    title: 'Changed in Issue detail',
    version: 3,
    status: 'completed',
  }
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi.fn().mockResolvedValueOnce(detailFor(issue)),
    comments: vi.fn().mockResolvedValue([]),
    updateDetail: vi.fn().mockResolvedValue(updated),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved: () => {} })
  try {
    await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(issue))
    await expect(
      state.updateDetail(issue.id, { title: updated.title, status: 'completed', version: 2 })
    ).resolves.toEqual(updated)
    expect(api.updateDetail).toHaveBeenCalledWith(issue.id, {
      version: 2,
      title: updated.title,
      status: 'completed',
    })
    expect(api.issueDetail).toHaveBeenCalledTimes(1)
  } finally {
    unsubscribe()
  }
})

test('retries shared details for an already created Issue without creating a duplicate', async () => {
  const create = vi.fn().mockResolvedValue(issue)
  const issueDetail = vi
    .fn()
    .mockResolvedValueOnce({ ...detailFor(issue), edit_context: null })
    .mockResolvedValue(detailFor(issue))
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    create,
    issueDetail,
    comments: vi.fn().mockResolvedValue([]),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, null)
  const onSaved = vi.fn()
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved })
  try {
    const draft = {
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      assignee_id: null,
      participants: [],
      due_at: null,
      archived: false,
    }
    await state.save(draft)
    expect(state.getSnapshot()).toMatchObject({
      editing: false,
      errorKind: 'saved-detail',
    })
    expect(onSaved).not.toHaveBeenCalled()
    await state.save(draft)
    state.retry()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(state.getSnapshot().issue?.detail?.id).toBe(issue.id)
    expect(create).toHaveBeenCalledOnce()
    expect(issueDetail.mock.calls).toEqual([[issue.id], [issue.id]])
  } finally {
    unsubscribe()
  }
})

test('archives without resubmitting the Issue and keeps participant changes atomic', async () => {
  const archived = {
    ...issue,
    version: 2,
    metadata: { ...issue.metadata, archived: true },
  }
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi.fn().mockResolvedValueOnce(detailFor(issue)),
    comments: vi.fn().mockResolvedValue([]),
    updateDetail: vi.fn().mockResolvedValue(archived),
    updateWithParticipants: vi.fn().mockResolvedValue({
      ...archived,
      version: 3,
      metadata: { ...archived.metadata, participants: [20] },
    }),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved: () => {} })
  try {
    await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(issue))
    await expect(state.toggleArchive()).resolves.toBe(true)
    expect(api.updateDetail).toHaveBeenCalledExactlyOnceWith(issue.id, {
      version: issue.version,
      archived: true,
    })
    state.beginEdit()
    const input = {
      title: issue.title,
      description: 'Invite a reviewer',
      status: issue.status,
      priority: issue.priority,
      assignee_id: 20,
      participants: [20],
      due_at: null,
      archived: true,
    }
    await state.save(input)
    expect(api.updateWithParticipants).toHaveBeenCalledExactlyOnceWith(issue.id, {
      ...input,
      version: archived.version,
    })
  } finally {
    unsubscribe()
  }
})

test('confirms a saved discussion post when refreshing Issue metadata fails', async () => {
  const posted = { id: 'comment-1', author_id: issue.creator_id, body: 'Progress', created_at: '' }
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi
      .fn()
      .mockResolvedValueOnce(detailFor(issue))
      .mockRejectedValueOnce(new Error('Refresh failed')),
    comments: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([posted]),
    comment: vi.fn().mockResolvedValue({ id: posted.id }),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved: () => {} })
  try {
    await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(issue))
    await expect(state.sendComment(posted.body)).resolves.toBe(true)
    expect(state.getSnapshot()).toMatchObject({ comments: [posted], busy: false })
  } finally {
    unsubscribe()
  }
})

test('adding a participant uses the saved collaborator and refreshes the Issue revision', async () => {
  const saved = {
    id: 'collaborator-12',
    loop_item_id: issue.id,
    user_id: 20,
    user_name: 'Colleague',
    email: null,
    source: 'manual',
    added_by_user_id: issue.creator_id,
    created_at: '',
  }
  const updated = { ...issue, version: 2 }
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi
      .fn()
      .mockResolvedValueOnce(detailFor(issue))
      .mockResolvedValueOnce(detailFor(updated)),
    comments: vi.fn().mockResolvedValue([]),
    addCollaborator: vi.fn().mockResolvedValue(saved),
  }
  const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
  const onSaved = vi.fn()
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved })
  try {
    await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(issue))
    await expect(state.addParticipant(issue.id, 20)).resolves.toEqual(saved)
    expect(api.addCollaborator).toHaveBeenCalledExactlyOnceWith(issue.id, 20)
    expect(state.getSnapshot().issue).toMatchObject(updated)
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(state.getSnapshot().issue)
  } finally {
    unsubscribe()
  }
})

test('removing a participant uses the shared action and refreshes the assignment', async () => {
  const current: IndependentIssue = {
    ...issue,
    version: 4,
    assignee_id: 20,
    metadata: {
      ...issue.metadata,
      participants: [20, 30],
      direct_participants: [20],
      resource_participants: [
        { kind: 'group', id: 10, name: 'Reviewers', team_id: null, human_ids: [30] },
      ],
    },
  }
  const api = {
    ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
    issueDetail: vi
      .fn()
      .mockResolvedValueOnce(detailFor(current))
      .mockResolvedValueOnce(
        detailFor({
          ...current,
          version: 5,
          assignee_id: null,
        })
      ),
    comments: vi.fn().mockResolvedValue([]),
    removeCollaborator: vi.fn().mockResolvedValue(undefined),
  }
  const state = createIndependentIssueDialogState(api, current.creator_id, current.id)
  const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved: () => {} })
  try {
    await vi.waitFor(() => expect(state.getSnapshot().issue).toMatchObject(current))
    await state.removeParticipant(current.id, 20)
    expect(api.removeCollaborator).toHaveBeenCalledExactlyOnceWith(current.id, 20)
    expect(state.getSnapshot().issue).toMatchObject({ version: 5, assignee_id: null })
  } finally {
    unsubscribe()
  }
})
