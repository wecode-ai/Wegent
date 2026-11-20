import { expect, test, vi } from 'vitest'
import { ApiError, createHttpClient } from '@/api/http'
import { createPersonalIssuesApi, type IndependentIssue } from '@/api/personalIssues'
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
  metadata: { standalone: true, participants: [], archived: false, due_at: null },
  people: {},
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
    let finishReload!: (issue: IndependentIssue) => void
    const reload = new Promise<IndependentIssue>(resolve => {
      finishReload = resolve
    })
    const api = {
      ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
      get: vi.fn().mockResolvedValueOnce(issue).mockReturnValueOnce(reload),
      comments: vi.fn().mockResolvedValue([]),
      remove: vi.fn(() => deletion),
    }
    const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
    const onSaved = vi.fn()
    const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved })
    try {
      await vi.waitFor(() => expect(state.getSnapshot().issue).toEqual(issue))
      const remove = state.remove()
      state.retry()
      expect(state.getSnapshot().loading).toBe(true)
      finishDelete(new ApiError('Issue unavailable', status))
      expect(await remove).toBe(removed)
      finishReload(issue)
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
