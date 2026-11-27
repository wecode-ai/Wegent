import { afterEach, expect, test, vi } from 'vitest'
import * as desktopHost from '@/api/dsh/desktopHost'
import * as nativeKey from './native-key-acknowledgement'
import * as observation from './native-key-observation'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('measures PageUp after the native buffer moves rather than at key acknowledgement', async () => {
  const viewport = document.createElement('div')
  viewport.dataset.testid = 'paging-viewport'
  const target = document.createElement('textarea')
  target.dataset.testid = 'paging-input'
  target.scrollIntoView = vi.fn()
  viewport.append(target)
  document.body.append(viewport)
  let position = 4
  let sampled!: () => void
  const firstRead = new Promise<void>(resolve => {
    sampled = resolve
  })
  const dispose = observation.registerNativeTerminalViewport(viewport, () => {
    sampled()
    return position
  })
  vi.spyOn(observation, 'createNativeKeyObservation').mockReturnValue({
    record: vi.fn(),
    result: () => '4',
  })
  vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(undefined as never)
  vi.spyOn(nativeKey, 'sendNativeKeyAndWait').mockImplementation(async (_target, _phase, send) => {
    await send()
  })
  let polls = 0
  const results: Array<{ ok: boolean; value: string }> = []
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (++polls > 1) return new Response(null, { status: 410 })
      return new Response(
        JSON.stringify({
          id: 'native-page-up',
          action: 'nativePress',
          selector: '[data-testid="paging-input"]',
          target: '[data-testid="paging-viewport"]',
          key: 'Shift+PageUp',
          timeoutMs: 1000,
        })
      )
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return new Response('{}')
  })
  const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
  try {
    await firstRead
    position = 1
    await client
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    expect(JSON.parse(results[0].value)).toEqual({ viewportBefore: '4', viewportAfter: '1' })
  } finally {
    position = 1
    await client
    dispose()
    viewport.remove()
  }
})
