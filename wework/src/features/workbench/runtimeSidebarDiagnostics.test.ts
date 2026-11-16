import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  debugRuntimeSidebarState,
  runtimeSidebarScrollMetrics,
  RuntimeSidebarScrollDiagnostics,
} from './runtimeSidebarDiagnostics'

const runtimeConfig = vi.hoisted(() => ({ controlUrl: '' }))
vi.mock('@/e2e/runtime-config', () => ({
  getDesktopE2ERuntimeConfig: () => runtimeConfig,
}))

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 240,
    width: 240,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function geometry(scrollTop: number, scrollHeight = 1000, clientHeight = 100) {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    loadStatusPresent: false,
    viewportRect: rect(10, clientHeight),
    activeRowRect: rect(30 - scrollTop, 30),
    activeRowInsideViewport: true,
    activeRowContentTop: 20,
  }
}

describe('runtime sidebar diagnostics', () => {
  beforeEach(() => {
    runtimeConfig.controlUrl = ''
    localStorage.clear()
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it('does not measure layout unless the existing runtime debug gate is enabled', () => {
    const details = vi.fn(() => ({ metrics: geometry(0) }))
    const metrics = vi.fn(() => geometry(0))
    const diagnostics = new RuntimeSidebarScrollDiagnostics()
    debugRuntimeSidebarState('active-task-auto-scroll', details)
    diagnostics.record(metrics, { taskId: 'task-1' })
    expect(details).not.toHaveBeenCalled()
    expect(metrics).not.toHaveBeenCalled()
    expect(console.debug).not.toHaveBeenCalled()

    localStorage.setItem('wework:debug-runtime', '1')
    debugRuntimeSidebarState('active-task-auto-scroll', details)
    expect(details).toHaveBeenCalledOnce()
    expect(console.debug).toHaveBeenCalledWith(
      '[Wework] Runtime sidebar state',
      expect.objectContaining({ event: 'active-task-auto-scroll' })
    )
  })

  it('captures only scalar geometry and row containment without reading task text', () => {
    const viewport = document.createElement('div')
    const row = document.createElement('div')
    row.textContent = 'Private task title and conversation body'
    viewport.append(row)
    viewport.scrollTop = 120
    Object.defineProperties(viewport, {
      scrollHeight: { value: 900 },
      clientHeight: { value: 200 },
    })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(100, 200))
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(80, 30))
    const metrics = runtimeSidebarScrollMetrics(viewport, row)
    expect(metrics).toMatchObject({
      scrollTop: 120,
      scrollHeight: 900,
      clientHeight: 200,
      loadStatusPresent: false,
      viewportRect: { top: 100, bottom: 300, height: 200 },
      activeRowRect: { top: 80, bottom: 110, height: 30 },
      activeRowInsideViewport: true,
      activeRowContentTop: 100,
    })
    expect(JSON.stringify(metrics)).not.toContain(row.textContent)
    expect(runtimeSidebarScrollMetrics(viewport, document.createElement('div'))).toMatchObject({
      activeRowInsideViewport: false,
    })
    expect(runtimeSidebarScrollMetrics(null, row)).toBeNull()
  })

  it('coalesces wheel events while recording geometry clamps immediately', () => {
    runtimeConfig.controlUrl = 'http://localhost/control'
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const diagnostics = new RuntimeSidebarScrollDiagnostics()
    diagnostics.record(() => geometry(0), { taskId: 'task-1' })
    now.mockReturnValue(100)
    diagnostics.record(() => geometry(50), { taskId: 'task-1' })
    now.mockReturnValue(200)
    diagnostics.record(() => geometry(200), { taskId: 'task-1' })
    expect(console.debug).toHaveBeenCalledTimes(1)

    now.mockReturnValue(210)
    diagnostics.record(() => geometry(150, 700, 80), { taskId: 'task-1' })
    expect(console.debug).toHaveBeenLastCalledWith(
      '[Wework] Runtime sidebar state',
      expect.objectContaining({
        event: 'worklists-scroll',
        geometryChanged: true,
        suppressedEvents: 2,
        previous: expect.objectContaining({ scrollTop: 200, scrollHeight: 1000 }),
        metrics: expect.objectContaining({ scrollTop: 150, scrollHeight: 700, clientHeight: 80 }),
      })
    )
    now.mockReturnValue(220)
    diagnostics.record(() => geometry(140, 700, 80), { taskId: 'task-1' })
    now.mockReturnValue(500)
    diagnostics.record(() => geometry(100, 700, 80), { taskId: 'task-1' })
    expect(console.debug).toHaveBeenCalledTimes(3)
    expect(console.debug).toHaveBeenLastCalledWith(
      '[Wework] Runtime sidebar state',
      expect.objectContaining({ geometryChanged: false, suppressedEvents: 1 })
    )
  })
})
