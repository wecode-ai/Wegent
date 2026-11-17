import { afterEach, expect, test, vi } from 'vitest'
import { runDesktopControlClient } from './automation'

const selector = '[data-testid="delayed-tab"]'
type Result = { ok: boolean; value?: string; error?: string }

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function click() {
  let delivered = false
  const results: Result[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (delivered) return new Response(null, { status: 410 })
      delivered = true
      return Response.json({ id: 'click', action: 'click', selector, timeoutMs: 30 })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  await runDesktopControlClient('http://127.0.0.1:43111', 'main')
  return results[0]
}

function mountButton(disabled = false) {
  const button = document.createElement('button')
  button.dataset.testid = 'delayed-tab'
  button.textContent = 'Task'
  button.disabled = disabled
  const clicked = vi.fn()
  button.onclick = clicked
  document.body.append(button)
  return clicked
}

test('waits for a tab mounted after the command queries the DOM and clicks it once', async () => {
  const query = document.querySelectorAll.bind(document)
  let clicked: ReturnType<typeof vi.fn> | undefined
  vi.spyOn(document, 'querySelectorAll').mockImplementation(value => {
    const elements = query(value)
    if (value === selector && elements.length === 0)
      queueMicrotask(() => {
        clicked = mountButton()
      })
    return elements
  })
  const result = await click()
  expect(result).toMatchObject({ ok: true, value: 'Task' })
  expect(clicked).toHaveBeenCalledOnce()
})

test('preserves failure when the requested tab never mounts', async () => {
  const result = await click()
  expect(result).toMatchObject({ ok: false })
  expect(result.error).toContain('Timed out waiting for selector')
})

test('rejects a mounted disabled control without dispatching a click', async () => {
  const clicked = mountButton(true)
  const result = await click()
  expect(result).toMatchObject({ ok: false })
  expect(result.error).toContain('is disabled')
  expect(clicked).not.toHaveBeenCalled()
})
