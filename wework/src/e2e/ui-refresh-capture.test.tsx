import { Profiler, StrictMode } from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let capture: typeof import('./ui-refresh-capture')
const active = new Set<{ captureId: string; rendererInstanceId: string }>()

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  capture = await import('./ui-refresh-capture')
  document.body.innerHTML =
    '<section id="sidebar"><span>old</span></section><main id="conversation"></main>'
})

afterEach(() => {
  for (const token of active) capture.stopUiRefreshCapture(token)
  active.clear()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function start(options: Parameters<typeof capture.startUiRefreshCapture>[0]) {
  const token = capture.startUiRefreshCapture(options)
  active.add(token)
  return token
}

function stop(token: ReturnType<typeof start>) {
  active.delete(token)
  return capture.stopUiRefreshCapture(token)
}

test('counts only the selected regions and flushes pending writes without sleeping', () => {
  const token = start({ regions: [{ name: 'sidebar', selector: '#sidebar' }] })
  const sidebar = document.querySelector('#sidebar')!
  sidebar.setAttribute('data-state', 'changed')
  sidebar.querySelector('span')!.firstChild!.textContent = 'new'
  document.querySelector('#conversation')!.append(document.createElement('div'))
  const result = stop(token)
  expect(result.regions.sidebar).toMatchObject({
    observed: true,
    mutationBatches: 1,
    mutationRecords: 2,
    attributeChanges: 1,
    textChanges: 1,
    addedNodes: 0,
    removedNodes: 0,
  })
  expect(result.reactCommits).toBeNull()
})

test('overlapping operation windows do not include writes from before they started', () => {
  const options = { regions: [{ name: 'sidebar', selector: '#sidebar' }], renderIds: [] }
  const first = start(options)
  document.querySelector('#sidebar')!.setAttribute('data-first', '1')
  const second = start(options)
  document.querySelector('#sidebar')!.setAttribute('data-second', '1')
  expect(stop(first).regions.sidebar.mutationBatches).toBe(2)
  expect(stop(second).regions.sidebar.mutationBatches).toBe(1)
})

test('captures transient roots and large subtree replacements', () => {
  const token = start({ regions: [{ name: 'probe', selector: '[data-probe]' }], renderIds: [] })
  const root = document.createElement('div')
  root.dataset.probe = 'true'
  root.innerHTML = '<div><span></span><span></span></div>'
  document.body.append(root)
  root.remove()
  const result = stop(token).regions.probe
  expect(result).toMatchObject({
    observed: true,
    initialMatches: 0,
    finalMatches: 0,
    mutationBatches: 1,
    addedNodes: 1,
    removedNodes: 1,
    rootRemovals: 1,
    maxAddedSubtreeElements: 4,
    maxRemovedSubtreeElements: 4,
  })
})

test('observes a selected root being replaced by its parent and keeps the new root', () => {
  const token = start({ regions: [{ name: 'sidebar', selector: '#sidebar' }], renderIds: [] })
  document.querySelector('#sidebar')!.outerHTML =
    '<section id="sidebar"><div><button></button></div></section>'
  const result = stop(token).regions.sidebar
  expect(result.rootRemovals).toBe(1)
  expect(result.maxAddedSubtreeElements).toBe(3)
  expect(result.finalMatches).toBe(1)
})

test('counts detached descendants by their mutation target inside the selected region', () => {
  const sidebar = document.querySelector('#sidebar')!
  sidebar.innerHTML = '<div data-testid="menu"><button></button><input /></div>'
  const token = start({ regions: [{ name: 'sidebar', selector: '#sidebar' }] })
  sidebar.querySelector('div')!.remove()
  const result = stop(token).regions.sidebar
  expect(result.removedNodes).toBe(1)
  expect(result.maxRemovedSubtreeElements).toBe(3)
  expect(result.rootRemovals).toBe(0)
})

test('keeps bounded removal provenance without retaining UI text or nodes', () => {
  const token = start({ regions: [{ name: 'body', selector: 'body' }] })
  for (let index = 0; index < 40; index += 1) {
    const node = document.createElement('div')
    node.dataset.testid = `panel-${index}`
    node.textContent = 'private conversation'
    document.body.append(node)
    node.remove()
  }
  const result = stop(token)
  expect(result.removals).toHaveLength(32)
  expect(result.removals[0].testIds).toEqual(['panel-8'])
  expect(result.removals.at(-1)).toMatchObject({ testIds: ['panel-39'], parent: null })
  expect(JSON.stringify(result.removals)).not.toContain('private conversation')
})

test('distinguishes real React render attempts from commits and unavailable instrumentation', () => {
  function Panel({ value }: { value: number }) {
    capture.recordUiRender('unit-panel')
    return <div data-testid="unit-panel">{value}</div>
  }
  const tree = (value: number) => (
    <StrictMode>
      <Profiler
        id="unit"
        onRender={(_id, _phase, duration) => capture.recordUiReactCommit(duration)}
      >
        <Panel value={value} />
      </Profiler>
    </StrictMode>
  )
  const view = render(tree(0))
  const token = start({
    regions: [{ name: 'panel', selector: '[data-testid="unit-panel"]' }],
    renderIds: ['unit-panel', 'uninstrumented'],
  })
  view.rerender(tree(1))
  const result = stop(token)
  expect(result.reactCommits?.count).toBe(1)
  expect(result.renders['unit-panel']).toBeGreaterThan(result.reactCommits!.count)
  expect(result.renders.uninstrumented).toBeNull()
  expect(result.regions.panel.textChanges).toBe(1)
})

test('rejects lost renderer identity and double stop instead of returning zero updates', () => {
  const token = start({})
  expect(() => capture.stopUiRefreshCapture({ ...token, rendererInstanceId: 'other' })).toThrow(
    'another renderer'
  )
  stop(token)
  expect(() => capture.stopUiRefreshCapture(token)).toThrow('already stopped')
})

test('rejects replacing the observed document root', () => {
  const token = start({})
  const original = document.documentElement
  const replacement = document.createElement('html')
  replacement.innerHTML = '<head></head><body></body>'
  document.replaceChild(replacement, original)
  try {
    expect(() => stop(token)).toThrow('document changed')
  } finally {
    document.replaceChild(original, replacement)
  }
})

test('missing selectors remain explicitly unobserved and invalid setup leaves no active capture', () => {
  expect(() => start({ regions: [{ name: 'bad', selector: '[' }] })).toThrow()
  const token = start({ regions: [{ name: 'missing', selector: '#missing' }], renderIds: [] })
  expect(stop(token).regions.missing.observed).toBe(false)
})

test('is disabled outside E2E', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  expect(() => start({})).toThrow('enabled E2E session')
})

test('render-only capture does not observe the DOM', () => {
  const observe = vi.spyOn(MutationObserver.prototype, 'observe')
  const token = start({ regions: [], renderIds: ['render-only'] })
  capture.recordUiRender('render-only')
  expect(stop(token).renders['render-only']).toBe(1)
  expect(observe).not.toHaveBeenCalled()
})

test('keeps fast commits even when legacy performance diagnostics are disabled', async () => {
  const { recordReactCommit } = await import('../lib/performanceDiagnostics')
  const token = start({ regions: [], renderIds: [] })
  recordReactCommit('wework-root', 'update', 1, 1, 0, 1)
  expect(stop(token).reactCommits).toEqual({ count: 1, actualDurationMs: 1 })
})

test('counts smaller subtree replacements after an earlier maximum in the same capture', () => {
  const token = start({ regions: [{ name: 'sidebar', selector: '#sidebar' }] })
  const sidebar = document.querySelector('#sidebar')!
  const replace = (children: number) => {
    const subtree = document.createElement('div')
    subtree.innerHTML = '<span></span>'.repeat(children)
    sidebar.append(subtree)
    subtree.remove()
  }
  replace(5)
  // Control transport serializes the snapshot before the next operation.
  const before = structuredClone(capture.readUiRefreshCapture(token).regions.sidebar)
  replace(2)
  const after = stop(token).regions.sidebar
  expect(before.maxRemovedSubtreeElements).toBe(6)
  expect(after.maxRemovedSubtreeElements).toBe(6)
  expect(after.addedSubtreeElements - before.addedSubtreeElements).toBe(3)
  expect(after.removedSubtreeElements - before.removedSubtreeElements).toBe(3)
  expect(after.removedNodes - before.removedNodes).toBe(1)
})

test('sums disjoint selected roots inside a replaced ancestor without double-counting nested matches', () => {
  const token = start({ regions: [{ name: 'panels', selector: '[data-region]' }], renderIds: [] })
  const wrapper = document.createElement('div')
  wrapper.innerHTML = [
    '<section data-region><div data-region><span></span></div></section>',
    '<section data-region><div><span></span><button></button></div></section>',
    '<aside><span></span><span></span></aside>',
  ].join('')
  document.body.append(wrapper)
  wrapper.remove()
  const result = stop(token).regions.panels
  expect(result).toMatchObject({
    observed: true,
    initialMatches: 0,
    finalMatches: 0,
    addedNodes: 1,
    removedNodes: 1,
    rootRemovals: 2,
    addedSubtreeElements: 7,
    removedSubtreeElements: 7,
    maxAddedSubtreeElements: 4,
    maxRemovedSubtreeElements: 4,
  })
})

test('records queued browser stalls and only safe script attribution', () => {
  let pending: PerformanceEntry[] = []
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      static supportedEntryTypes = ['longtask', 'long-animation-frame']
      observe() {}
      takeRecords() {
        const entries = pending
        pending = []
        return entries
      }
      disconnect() {}
    }
  )
  const token = start({ regions: [], renderIds: [] })
  const at = performance.now()
  pending = [
    { entryType: 'longtask', startTime: at, duration: 7577 } as PerformanceEntry,
    {
      entryType: 'long-animation-frame',
      startTime: at,
      duration: 8000,
      scripts: [
        {
          startTime: at,
          duration: 7500,
          forcedStyleAndLayoutDuration: 0,
          sourceURL: 'https://private.example/assets/app-abcdefgh.js?token=PRIVATE_MARKER',
          sourceFunctionName: 'renderMessage',
          invokerType: 'event-listener',
        },
        ...[20, 25, 30].map(forcedStyleAndLayoutDuration => ({
          startTime: at,
          duration: 100,
          forcedStyleAndLayoutDuration,
          sourceURL: 'https://private.example/assets/app-abcdefgh.js?token=PRIVATE_MARKER',
          sourceFunctionName: 'measureLayout',
          invokerType: 'event-listener',
        })),
      ],
    } as unknown as PerformanceEntry,
  ]
  const snapshot = capture.readUiRefreshCapture(token)
  expect(snapshot.responsiveness).toMatchObject({
    longTaskCount: 1,
    longTaskMaxMs: 7577,
    frameCount: 1,
    slowScriptCount: 4,
    slowScriptMaxMs: 7500,
  })
  expect(snapshot.responsiveness).not.toHaveProperty('events')
  const detail = capture.getUiResponsivenessDiagnostics()
  expect(detail.captures[0].events).toHaveLength(5)
  expect(
    detail.captures[0].events.find(event => event.kind === 'slow-script')?.details.elapsedMs
  ).toBe(7500)
  expect(
    detail.captures[0].events.find(event => event.kind === 'long-frame')?.details
  ).toMatchObject({
    slowScriptCount: 4,
    slowScriptMaxMs: 7500,
    omittedSlowScripts: 1,
  })
  expect(JSON.stringify(detail)).toContain('app-abcdefgh.js')
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_MARKER')
  expect(JSON.stringify(detail)).not.toContain('private.example')
  expect(stop(token).responsiveness.longTaskCount).toBe(1)
})

test('unsupported browser timings remain unavailable rather than zero', () => {
  vi.stubGlobal('PerformanceObserver', undefined)
  const snapshot = stop(start({ regions: [], renderIds: [] }))
  expect(snapshot.responsiveness).toMatchObject({
    supportedEntryTypes: [],
    unavailableReason: 'not-supported',
    longTaskCount: null,
    frameCount: null,
  })
})
