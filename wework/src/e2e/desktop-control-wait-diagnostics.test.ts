import { afterEach, expect, test, vi } from 'vitest'
import { runDesktopControlClient } from './automation'

const selector = '[data-testid="late-ready"]'
type Result = { ok: boolean; error?: string }

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function failedWait() {
  let delivered = false
  const results: Result[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (delivered) return new Response(null, { status: 410 })
      delivered = true
      return Response.json({ id: 'wait', action: 'waitFor', selector, timeoutMs: 30 })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
  await vi.advanceTimersByTimeAsync(100)
  await client
  expect(results[0].ok).toBe(false)
  const match = /; wait=(.*?); matches=/.exec(results[0].error!)
  expect(match).not.toBeNull()
  return { error: results[0].error!, diagnostic: JSON.parse(match![1]) }
}

test('distinguishes a missing condition from unavailable poll observations', async () => {
  vi.useFakeTimers()
  const { diagnostic } = await failedWait()
  expect(diagnostic.timeoutMs).toBe(30)
  expect(diagnostic.polls).toBeGreaterThan(0)
  expect(diagnostic.lastMatchCount).toBe(0)
  expect(diagnostic.lastPollAtMs).toBeLessThan(diagnostic.timeoutMs)
  expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(diagnostic.timeoutMs)
})

test('retains the deadline failure when a match appears after the last predicate check', async () => {
  vi.useFakeTimers()
  const query = document.querySelectorAll.bind(document)
  let inserted = false
  vi.spyOn(document, 'querySelectorAll').mockImplementation(value => {
    const elements = query(value)
    if (value === selector && !inserted) {
      inserted = true
      const button = document.createElement('button')
      button.dataset.testid = 'late-ready'
      button.getBoundingClientRect = () => new DOMRect(0, 0, 32, 32)
      button.textContent = 'Private UI text'
      document.body.append(button)
      vi.setSystemTime(Date.now() + 100)
    }
    return elements
  })
  const { error, diagnostic } = await failedWait()
  expect(diagnostic.polls).toBe(1)
  expect(diagnostic.lastMatchCount).toBe(0)
  expect(diagnostic.maxPollGapMs).toBeGreaterThanOrEqual(100)
  expect(error).toContain('"testid":"late-ready"')
  expect(error).not.toContain('Private UI text')
})
