import { describe, expect, it, vi } from 'vitest'
import { createReplyPredictionApi } from './replyPredictionApi'

describe('reply prediction model preparation', () => {
  it('does not send a request cancelled while model credentials are being resolved', async () => {
    let finish!: (config: Record<string, unknown>) => void
    const request = vi.fn()
    const resolveModelConfig = vi.fn(
      () =>
        new Promise<Record<string, unknown>>(resolve => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const api = createReplyPredictionApi(request, resolveModelConfig)
    const pending = api.predict({
      address: { deviceId: 'device-1', taskId: 'task-1' },
      signal: controller.signal,
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    finish({ api_key: 'current-key' })
    await vi.waitFor(() => expect(resolveModelConfig).toHaveResolved())
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds credential preparation time without starting or cancelling executor work', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      const api = createReplyPredictionApi(request, () => new Promise(() => {}))
      const pending = api.predict({ address: { deviceId: 'device-1', taskId: 'task-1' } })
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(30000)
      await rejection
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
