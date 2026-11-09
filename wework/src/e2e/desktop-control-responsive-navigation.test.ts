import { afterEach, expect, test, vi } from 'vitest'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  ['button', 'button'],
  ['select', 'select'],
  ['button', 'select'],
  ['select', 'button'],
] as const)('selects the live %s -> %s layout in one renderer command', async (before, after) => {
  const surface = document.createElement('section')
  surface.dataset.testid = 'responsive-project'
  document.body.append(surface)
  const changed = vi.fn()
  const mount = (layout: 'button' | 'select') => {
    surface.innerHTML =
      layout === 'select'
        ? '<select data-testid="view-select"><option value="board">Board</option><option value="manage">Manage</option></select>'
        : '<button data-testid="view-manage">Manage</button>'
    const control = surface.firstElementChild as HTMLElement
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 30))
    control.addEventListener(layout === 'select' ? 'change' : 'click', changed)
  }
  mount(before)
  const results: Array<{ ok: boolean; value?: string }> = []
  let polls = 0
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (++polls > 1) return new Response(null, { status: 410 })
      // ResizeObserver has replaced the old layout before the command reaches the renderer.
      if (before !== after) mount(after)
      return Response.json({
        id: 'responsive-navigation',
        action: 'chooseWhenEnabled',
        selector:
          '[data-testid="responsive-project"] [data-testid="view-select"], [data-testid="responsive-project"] [data-testid="view-manage"]',
        value: 'manage',
        visible: true,
      })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return Response.json({})
  })
  await runDesktopControlClient('http://127.0.0.1:43111', 'main')
  expect(results).toEqual([expect.objectContaining({ ok: true, value: 'Manage' })])
  expect(changed).toHaveBeenCalledOnce()
  if (after === 'select')
    expect((surface.firstElementChild as HTMLSelectElement).value).toBe('manage')
})

test('does not accept a non-interactive replacement or an unavailable option', async () => {
  const surface = document.createElement('section')
  surface.innerHTML =
    '<div data-testid="not-control">Manage</div><select data-testid="missing-option"><option value="board">Board</option></select>'
  document.body.append(surface)
  for (const control of surface.children) {
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 30))
  }
  const results: Array<{ ok: boolean; error?: string }> = []
  let polls = 0
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (++polls > 2) return new Response(null, { status: 410 })
      return Response.json({
        id: String(polls),
        action: 'chooseWhenEnabled',
        selector: `[data-testid="${polls === 1 ? 'not-control' : 'missing-option'}"]`,
        value: 'manage',
      })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return Response.json({})
  })
  await runDesktopControlClient('http://127.0.0.1:43111', 'main')
  expect(results.map(result => result.ok)).toEqual([false, false])
  expect(results[0].error).toContain('Choice target must be a select or button element')
  expect(results[1].error).toContain('Unable to find select option')
})
