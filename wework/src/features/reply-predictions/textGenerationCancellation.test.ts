import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancellableTextGeneration, textGenerationRequest } from './textGenerationCancellation'

describe('text generation cancellation', () => {
  afterEach(() => vi.useRealTimers())
  it('does not start an already cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn()
    await expect(cancellableTextGeneration(controller.signal, 30000, run)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(run).not.toHaveBeenCalled()
  })
  it('bounds preparation time and cancels executor work exactly once', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(async () => {})
    const start = vi.fn(() => new Promise<string>(() => {}))
    const pending = cancellableTextGeneration(undefined, 30000, signal =>
      textGenerationRequest(signal, start, cancel)
    )
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(30000)
    await assertion
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('removes cancellation listeners after success', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => {})
    expect(await textGenerationRequest(controller.signal, async () => 'ready', cancel)).toBe(
      'ready'
    )
    controller.abort()
    expect(cancel).not.toHaveBeenCalled()
  })
})
