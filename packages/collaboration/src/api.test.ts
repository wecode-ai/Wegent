// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

import { createCollaborationApi, type CollaborationHttpClient } from './api'

function client(): CollaborationHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

describe('createCollaborationApi', () => {
  it('uses the shared cloud project and Issue endpoints', async () => {
    const http = client()
    vi.mocked(http.get).mockResolvedValueOnce({ items: [{ id: '17' }] })
    vi.mocked(http.post).mockResolvedValueOnce({ id: 'COLLAB-1' })
    vi.mocked(http.patch).mockResolvedValueOnce({ id: 'COLLAB-1', version: 2 })

    const api = createCollaborationApi(http)

    await expect(api.listProjects()).resolves.toEqual([{ id: '17' }])
    await api.createIssue('17', { title: 'Shared issue' })
    await api.updateIssue('COLLAB-1', { version: 1, status: 'in_progress' })

    expect(http.get).toHaveBeenCalledWith('/v1/cloud-projects')
    expect(http.post).toHaveBeenCalledWith('/v1/cloud-projects/17/loop-items', {
      title: 'Shared issue',
    })
    expect(http.patch).toHaveBeenCalledWith('/v1/loop-items/COLLAB-1', {
      version: 1,
      status: 'in_progress',
    })
  })

  it('shares comments and multipart attachments across hosts', async () => {
    const http = client()
    vi.mocked(http.get).mockResolvedValueOnce([])
    vi.mocked(http.post).mockResolvedValueOnce({ id: 'comment-1' })
    vi.mocked(http.postForm!).mockResolvedValueOnce({ id: 'attachment-1' })

    const api = createCollaborationApi(http)
    const file = new File(['evidence'], 'evidence.txt', { type: 'text/plain' })

    await api.listComments('COLLAB-1')
    await api.addComment('COLLAB-1', 'Ready')
    await api.addAttachment('COLLAB-1', file)

    expect(http.get).toHaveBeenCalledWith('/v1/loop-items/COLLAB-1/comments')
    expect(http.post).toHaveBeenCalledWith('/v1/loop-items/COLLAB-1/comments', {
      body: 'Ready',
    })
    expect(http.postForm).toHaveBeenCalledWith(
      '/v1/loop-items/COLLAB-1/attachments',
      expect.any(FormData)
    )
  })

  it('normalizes execution responses once for both frontends', async () => {
    const http = client()
    vi.mocked(http.get).mockResolvedValueOnce({
      items: [
        {
          id: '9',
          loopItemId: 'COLLAB-1',
          taskTitle: 'Build',
          executorType: 'ClaudeCode',
          status: 'running',
          displayState: 'running',
          observedState: 'running',
          syncState: 'synced',
          startedAt: '2026-09-10T10:00:00Z',
        },
      ],
    })

    const api = createCollaborationApi(http)

    await expect(api.listExecutions('17')).resolves.toEqual([
      {
        id: 9,
        loop_item_id: 'COLLAB-1',
        task_title: 'Build',
        executor_type: 'ClaudeCode',
        status: 'running',
        display_state: 'running',
        observed_state: 'running',
        sync_state: 'synced',
        started_at: '2026-09-10T10:00:00Z',
        completed_at: null,
        error_message: null,
      },
    ])
  })
})
