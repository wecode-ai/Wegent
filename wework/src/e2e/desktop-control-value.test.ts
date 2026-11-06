import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { runDesktopControlClient } from './automation'

const selector = '[data-testid="cloud-todo-detail-title"]'
const title = '在通知内继续处理分身任务'
type Result = { id: string; ok: boolean; value?: string; error?: string }

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountTitle(value = title) {
  const input = document.createElement('textarea')
  input.dataset.testid = 'cloud-todo-detail-title'
  input.value = value
  document.body.append(input)
  return input
}

async function execute(commands: DesktopControlCommand[], onResult?: (result: Result) => void) {
  const results: Result[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      const next = commands.shift()
      return next ? Response.json(next) : new Response(null, { status: 410 })
    }
    if (url.endsWith('/results')) {
      const result = JSON.parse(String(init?.body)) as Result
      results.push(result)
      onResult?.(result)
    }
    return Response.json({})
  })
  await runDesktopControlClient('http://127.0.0.1:43111', 'main')
  return results
}

test('captures the actual value before a microtask unmounts the matched detail', async () => {
  const input = mountTitle()
  const query = document.querySelectorAll.bind(document)
  vi.spyOn(document, 'querySelectorAll').mockImplementation(value => {
    const elements = query(value)
    if (value === selector && elements.length) queueMicrotask(() => input.remove())
    return elements
  })

  const results = await execute([{ id: 'title', action: 'getValueWhenReady', selector }])

  expect(input.isConnected).toBe(false)
  expect(results).toEqual([{ id: 'title', clientId: expect.any(String), ok: true, value: title }])
})

test('requeries when the detail unmounts between the original wait and value read', async () => {
  const initial = mountTitle('Earlier title')
  const query = document.querySelectorAll.bind(document)
  let replaced = false
  vi.spyOn(document, 'querySelectorAll').mockImplementation(value => {
    const elements = query(value)
    if (value === selector && elements.length === 0 && !replaced) {
      replaced = true
      queueMicrotask(() => mountTitle())
    }
    return elements
  })

  const results = await execute(
    [
      { id: 'presence', action: 'waitFor', selector },
      { id: 'title', action: 'getValueWhenReady', selector },
    ],
    result => {
      if (result.id === 'presence') initial.remove()
    }
  )

  expect(replaced).toBe(true)
  expect(results.find(result => result.id === 'title')).toEqual({
    id: 'title',
    clientId: expect.any(String),
    ok: true,
    value: title,
  })
})

test('keeps the bounded failure when the requested detail never appears', async () => {
  const results = await execute([
    { id: 'missing', action: 'getValueWhenReady', selector, timeoutMs: 30 },
  ])

  expect(results[0]).toMatchObject({ id: 'missing', ok: false })
  expect(results[0].error).toContain('Timed out waiting for selector')
})

test('returns an incorrect title unchanged so the original equality assertion rejects it', async () => {
  mountTitle('Another Issue')

  const results = await execute([{ id: 'wrong', action: 'getValueWhenReady', selector }])

  expect(results[0]).toMatchObject({ ok: true, value: 'Another Issue' })
  expect(() => expect(results[0].value).toBe(title)).toThrow()
})
