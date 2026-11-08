import { afterEach, expect, it, vi } from 'vitest'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('waits for the semantic selector and captures metrics in the same renderer operation', async () => {
  const tab = document.createElement('button')
  tab.dataset.testid = 'ready-tab'
  tab.dataset.state = 'known'
  tab.title = 'Ready'
  document.body.append(tab)
  vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20))
  const results: Array<{ ok: boolean; value?: string }> = []
  let polls = 0
  let restore: ReturnType<typeof setTimeout> | undefined
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (++polls > 1) return Promise.resolve(new Response(null, { status: 410 }))
      // A background refresh invalidates an earlier ready observation before dispatch.
      expect(tab.dataset.state).toBe('known')
      tab.dataset.state = 'unknown'
      restore = setTimeout(() => {
        tab.dataset.state = 'known'
        tab.textContent = 'Ready'
      }, 0)
      return Promise.resolve(
        Response.json({
          id: 'coherent-ready-snapshot',
          action: 'getElementMetrics',
          selector: '[data-testid="ready-tab"][data-state="known"]',
          value: JSON.stringify({
            includeText: true,
            attributeNames: ['title', 'data-state'],
            waitForMatch: true,
          }),
        })
      )
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return Promise.resolve(new Response('{}'))
  })
  try {
    await runDesktopControlClient('http://127.0.0.1:43111', 'main')
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    const metrics = JSON.parse(results[0].value!)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({
      text: 'Ready',
      width: 100,
      attributes: { title: 'Ready', 'data-state': 'known' },
    })
  } finally {
    clearTimeout(restore)
  }
})
