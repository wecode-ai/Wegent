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
    const api = {
      ...createPersonalIssuesApi(createHttpClient({ baseUrl: 'https://backend.example.test/api' })),
      get: vi.fn().mockResolvedValue(issue),
      comments: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockRejectedValue(new ApiError('Issue unavailable', status)),
    }
    const state = createIndependentIssueDialogState(api, issue.creator_id, issue.id)
    const onSaved = vi.fn()
    const unsubscribe = state.subscribe(() => {}, { onClose: () => {}, onSaved })
    try {
      await vi.waitFor(() => expect(state.getSnapshot().issue).toEqual(issue))
      expect(await state.remove()).toBe(removed)
      expect(state.getSnapshot()).toMatchObject({
        issue: null,
        busy: false,
        error: removed ? '' : 'Issue unavailable',
      })
      expect(onSaved.mock.calls).toEqual(removed ? [[null]] : [])
    } finally {
      unsubscribe()
    }
  }
)
