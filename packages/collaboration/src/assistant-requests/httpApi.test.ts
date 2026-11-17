import { describe, expect, it, vi } from 'vitest'
import { createAssistantRequestsHttpApi } from './httpApi'

const row = {
  requestId: 'request-1',
  parentRequestId: null,
  ownerUserId: 7,
  deviceId: 'device-1',
  runtimeTaskId: 'assistant-request-request-1',
  conversationId: 'assistant-request-request-1',
  executionId: '11',
  state: 'queued',
  queuePosition: 1,
  reasonCode: null,
  updatedAt: '2026-11-17T00:00:00Z',
  message: 'Private request',
  commands: [],
}

describe('assistant requests HTTP API', () => {
  it('uses the explicit action contract without changing idempotency keys or message text', async () => {
    const get = vi.fn().mockResolvedValue({ enabled: true, requests: [row] })
    const post = vi.fn().mockResolvedValue(row)
    const api = createAssistantRequestsHttpApi({ get, post })
    const input = {
      action: 'followup' as const,
      requestId: row.requestId,
      idempotencyKey: 'same-key',
      message: 'Literal parentRequestId and `code_value`',
    }
    expect(await api.list('project /', 'issue /')).toEqual({
      enabled: true,
      requests: [row],
    })
    expect(get).toHaveBeenCalledWith(
      '/v1/cloud-projects/project%20%2F/loop-items/issue%20%2F/assistant-requests',
    )
    expect(await api.submit('project /', 'issue /', input)).toEqual(row)
    expect(post).toHaveBeenCalledWith(
      '/v1/cloud-projects/project%20%2F/loop-items/issue%20%2F/assistant-requests',
      input,
    )
  })

  it('does not cache private owner reads and excludes unrecognized response fields', async () => {
    const get = vi.fn().mockResolvedValue({
      enabled: false,
      requests: [{ ...row, credentials: 'never forwarded' }],
    })
    const api = createAssistantRequestsHttpApi({ get, post: vi.fn() })
    expect((await api.list('p', 'i')).requests[0]).toEqual(row)
    await api.list('p', 'i')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('delivers merge rechecks through the existing request action endpoint', async () => {
    const command = {
      id: 'check',
      action: 'prepare_merge',
      executionId: '11',
      acknowledged: false,
    }
    const post = vi.fn().mockResolvedValue({ ...row, commands: [command] })
    const api = createAssistantRequestsHttpApi({ get: vi.fn(), post })
    const input = {
      action: 'prepare_merge' as const,
      requestId: row.requestId,
      idempotencyKey: 'check-key',
    }
    expect((await api.submit('p', 'i', input)).commands).toEqual([command])
    expect(post).toHaveBeenCalledWith(
      '/v1/cloud-projects/p/loop-items/i/assistant-requests',
      input,
    )
  })

  it('uses the separate human merge confirmation endpoint and whitelists its evidence', async () => {
    const merge = {
      state: 'awaiting_confirmation',
      targetRef: 'refs/heads/main',
      targetRevision: 'target',
      requestRevision: 'request',
      candidateRevision: 'candidate',
      mergedRevision: null,
      conflictFiles: [],
      reasonCode: null,
    }
    const post = vi.fn().mockResolvedValue({
      ...row,
      worktree: {
        worktreeId: 'worktree-1',
        deviceId: 'native-device',
        request: {
          requestId: row.requestId,
          ownerUserId: 7,
          conversationId: row.conversationId,
          deviceId: 'native-device',
        },
        path: 'C:\\worktrees\\request',
        merge: { ...merge, transcript: 'private' },
      },
      commands: [
        {
          id: 'm',
          action: 'merge',
          executionId: '11',
          approvedByUserId: 7,
          targetRevision: 'target',
          candidateRevision: 'candidate',
          acknowledged: false,
          reasonCode: 'worktree_merge_target_dirty',
        },
      ],
    })
    const api = createAssistantRequestsHttpApi({ get: vi.fn(), post })
    const input = {
      idempotencyKey: 'merge-key',
      targetRevision: 'target',
      candidateRevision: 'candidate',
    }
    const result = await api.confirmMerge('p', 'i', row.requestId, input)
    expect(post).toHaveBeenCalledWith(
      '/v1/cloud-projects/p/loop-items/i/assistant-requests/request-1/merge',
      input,
    )
    expect(result.worktree?.merge).toEqual(merge)
    expect(result.worktree?.path).toBe('C:\\worktrees\\request')
    expect(result.commands[0]).toMatchObject({
      action: 'merge',
      approvedByUserId: 7,
      reasonCode: 'worktree_merge_target_dirty',
    })
  })

  it.each([
    { enabled: 'yes', requests: [] },
    { enabled: true, requests: [{ ...row, ownerUserId: '7' }] },
    { enabled: true, requests: [{ ...row, queuePosition: -1 }] },
    {
      enabled: true,
      requests: [{ ...row, commands: [{ id: 'c', action: 'new_request' }] }],
    },
    {
      enabled: true,
      requests: [
        {
          ...row,
          commands: [{ id: 'c', action: 'prepare_merge', acknowledged: false }],
        },
      ],
    },
    {
      enabled: true,
      requests: [{ ...row, worktree: { request: { requestId: 'foreign' } } }],
    },
  ])(
    'rejects an invalid response instead of presenting acceptance',
    async (response) => {
      const api = createAssistantRequestsHttpApi({
        get: vi.fn().mockResolvedValue(response),
        post: vi.fn(),
      })
      await expect(api.list('p', 'i')).rejects.toThrow(
        'Invalid assistant request',
      )
    },
  )
})
