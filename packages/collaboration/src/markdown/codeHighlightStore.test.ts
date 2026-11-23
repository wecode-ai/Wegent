import { expect, it, vi } from 'vitest'
import type { HighlightedCode } from './highlightCode'
import { createCodeHighlightStore } from './codeHighlightStore'

function fixture() {
  const jobs: Array<{
    code: string
    language: string
    promise: Promise<HighlightedCode>
    resolve(result: HighlightedCode): void
    reject(cause: Error): void
  }> = []
  const release = vi.fn()
  const retain = vi.fn(() => release)
  const highlight = vi.fn((code: string, language: string) => {
    let resolve!: (result: HighlightedCode) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<HighlightedCode>((accept, fail) => {
      resolve = accept
      reject = fail
    })
    jobs.push({ code, language, promise, resolve, reject })
    return promise
  })
  const store = createCodeHighlightStore({ retain, highlight })
  return { jobs, release, retain, highlight, store }
}

it('keeps one worker owner and coalesces intermediate streamed text while a job is busy', async () => {
  const f = fixture()
  const first = f.store.subscribe(vi.fn(), { code: 'a', language: 'typescript' })
  first()
  const second = f.store.subscribe(vi.fn(), { code: 'ab', language: 'typescript' })
  second()
  const last = f.store.subscribe(vi.fn(), { code: 'abc', language: 'typescript' })
  await Promise.resolve()
  expect(f.retain).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
  expect(f.highlight).toHaveBeenCalledExactlyOnceWith('a', 'typescript')
  f.jobs[0].resolve({ code: 'a', html: 'Highlighted prefix' })
  await vi.waitFor(() => expect(f.highlight).toHaveBeenLastCalledWith('abc', 'typescript'))
  expect(f.store.getSnapshot()).toMatchObject({ code: 'a', html: 'Highlighted prefix' })
  f.jobs[1].resolve({ code: 'abc', html: 'Final highlight' })
  await vi.waitFor(() => expect(f.store.getSnapshot()?.code).toBe('abc'))
  expect(f.highlight).toHaveBeenCalledTimes(2)
  last()
  await Promise.resolve()
  expect(f.release).toHaveBeenCalledOnce()
})

it.each([
  { code: 'let x', language: 'plaintext' },
  { code: 'replacement text', language: 'typescript' },
])('rejects obsolete work when the next input is $code ($language)', async next => {
  const f = fixture()
  const first = f.store.subscribe(vi.fn(), { code: 'let x', language: 'typescript' })
  first()
  const last = f.store.subscribe(vi.fn(), next)
  f.jobs[0].resolve({ code: 'let x', html: 'Old syntax tokens' })
  await vi.waitFor(() => expect(f.highlight).toHaveBeenLastCalledWith(next.code, next.language))
  expect(f.store.getSnapshot()).toBeNull()
  f.jobs[1].resolve({ code: next.code, html: 'Current source' })
  await vi.waitFor(() =>
    expect(f.store.getSnapshot()).toMatchObject({
      language: next.language,
      code: next.code,
      html: 'Current source',
    })
  )
  last()
  await Promise.resolve()
})

it('releases the last owner and ignores late errors without starting queued work', async () => {
  const f = fixture()
  const listener = vi.fn()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const first = f.store.subscribe(listener, { code: 'a', language: 'typescript' })
    first()
    const last = f.store.subscribe(listener, { code: 'ab', language: 'typescript' })
    last()
    await Promise.resolve()
    expect(f.release).toHaveBeenCalledOnce()
    f.jobs[0].reject(new Error('Late worker error'))
    await f.jobs[0].promise.catch(() => {})
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(f.store.getSnapshot()).toBeNull()
    expect(f.highlight).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})
