import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function execute(target?: string) {
  const element = document.createElement('span')
  element.dataset.testid = 'state-trail'
  document.body.append(element)
  const readProperty = vi.fn(() => ' none ')
  const computedStyle = vi.fn(() => ({ getPropertyValue: readProperty }))
  vi.stubGlobal('getComputedStyle', computedStyle)
  const command: DesktopControlCommand = {
    id: 'state-animation',
    action: 'getComputedStyleValue',
    selector: '[data-testid="state-trail"]',
    value: 'animation-name',
    ...(target === undefined ? {} : { target }),
  }
  const results: { ok: boolean; value?: string; error?: string }[] = []
  let sent = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (sent) return new Response(null, { status: 410 })
      sent = true
      return Response.json(command)
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  await runDesktopControlClient('http://127.0.0.1:43111', 'main')
  return { element, results, computedStyle, readProperty }
}

test('keeps the existing element style command and trimmed CSS value', async () => {
  const { element, results, computedStyle, readProperty } = await execute()
  expect(results).toMatchObject([{ ok: true, value: 'none' }])
  expect(computedStyle).toHaveBeenCalledWith(element, undefined)
  expect(readProperty).toHaveBeenCalledWith('animation-name')
})

test.each(['::before', '::after'])('reads the real %s pseudo-element style', async target => {
  const { element, results, computedStyle } = await execute(target)
  expect(results).toMatchObject([{ ok: true, value: 'none' }])
  expect(computedStyle).toHaveBeenCalledWith(element, target)
})

test.each(['span', '::marker', ''])(
  'rejects an unsupported pseudo-element target %j',
  async target => {
    const { results, computedStyle } = await execute(target)
    expect(results).toMatchObject([
      { ok: false, error: expect.stringContaining('target must be ::before or ::after') },
    ])
    expect(computedStyle).not.toHaveBeenCalled()
  }
)
