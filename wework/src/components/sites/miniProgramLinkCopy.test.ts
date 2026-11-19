import { copyTextToClipboard } from '@/lib/clipboard'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMiniProgramLinkCopy } from './miniProgramLinkCopy'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mini program copy receipts', () => {
  test('writes only on request and expires feedback after 1500ms', async () => {
    const copy = createMiniProgramLinkCopy('https://example.com/a')
    const changed = vi.fn()
    const stop = copy.subscribe(changed)
    expect(copyTextToClipboard).not.toHaveBeenCalled()
    await copy.copy()
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://example.com/a')
    expect(copy.getSnapshot()).toBe('copied')
    vi.advanceTimersByTime(1499)
    expect(copy.getSnapshot()).toBe('copied')
    vi.advanceTimersByTime(1)
    expect(copy.getSnapshot()).toBe('idle')
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
  })

  test('ignores completion after disposal even when the same owner is observed again', async () => {
    const pending = deferred()
    vi.mocked(copyTextToClipboard).mockReturnValueOnce(pending.promise)
    const copy = createMiniProgramLinkCopy('https://example.com/a')
    const stop = copy.subscribe(vi.fn())
    const operation = copy.copy()
    stop()
    const changed = vi.fn()
    const stopAgain = copy.subscribe(changed)
    pending.resolve()
    await operation
    expect(copy.getSnapshot()).toBe('idle')
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stopAgain()
  })

  test('keeps results scoped to the requested link', async () => {
    const pending = deferred()
    vi.mocked(copyTextToClipboard).mockReturnValueOnce(pending.promise)
    const old = createMiniProgramLinkCopy('https://example.com/a')
    const stopOld = old.subscribe(vi.fn())
    const operation = old.copy()
    stopOld()
    const current = createMiniProgramLinkCopy('https://example.com/b')
    const stopCurrent = current.subscribe(vi.fn())
    await current.copy()
    pending.resolve()
    await operation
    expect(old.getSnapshot()).toBe('idle')
    expect(current.getSnapshot()).toBe('copied')
    stopCurrent()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a superseded failure does not overwrite the latest success', async () => {
    const pending = deferred()
    vi.mocked(copyTextToClipboard).mockReturnValueOnce(pending.promise)
    const copy = createMiniProgramLinkCopy('https://example.com/a')
    const stop = copy.subscribe(vi.fn())
    const operation = copy.copy()
    await copy.copy()
    pending.reject(new Error('old request failed'))
    await operation
    expect(copy.getSnapshot()).toBe('copied')
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('reports failure and allows an explicit retry', async () => {
    const failure = new Error('clipboard denied')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(failure)
    const copy = createMiniProgramLinkCopy('https://example.com/a')
    const stop = copy.subscribe(vi.fn())
    await copy.copy()
    expect(copy.getSnapshot()).toBe('failed')
    expect(log).toHaveBeenCalledWith('Failed to copy mini program URL:', failure)
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
    await copy.copy()
    expect(copy.getSnapshot()).toBe('copied')
    stop()
  })

  test('does not retain a timer when receipt notification disposes the owner', async () => {
    const copy = createMiniProgramLinkCopy('https://example.com/a')
    const stop = copy.subscribe(() => stop())
    await copy.copy()
    expect(copy.getSnapshot()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })
})
