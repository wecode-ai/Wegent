import { describe, expect, test, vi } from 'vitest'
import { createImSessionApi } from './imSessions'
import type { HttpClient } from './http'

describe('createImSessionApi', () => {
  test('lists private IM sessions', async () => {
    const get = vi.fn().mockResolvedValue({ total: 0, items: [] })
    const api = createImSessionApi({ get } as unknown as HttpClient)

    await expect(api.listPrivateSessions()).resolves.toEqual({ total: 0, items: [] })

    expect(get).toHaveBeenCalledWith('/im/private-sessions')
  })

  test('binds private IM sessions to a task', async () => {
    const post = vi.fn().mockResolvedValue({
      task_id: 42,
      bound_session_ids: [7, 9],
      notified_count: 2,
    })
    const api = createImSessionApi({ post } as unknown as HttpClient)

    await expect(api.bindTaskSessions(42, [7, 9])).resolves.toEqual({
      task_id: 42,
      bound_session_ids: [7, 9],
      notified_count: 2,
    })

    expect(post).toHaveBeenCalledWith('/tasks/42/im-sessions', {
      session_ids: [7, 9],
    })
  })
})
