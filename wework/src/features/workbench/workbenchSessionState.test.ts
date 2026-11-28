import { expect, test, vi } from 'vitest'
import { performance as diagnosticsPerformance } from 'node:perf_hooks'
import { LOCAL_USER } from '@/api/local/localSession'
import { beginPluginRefreshDiagnostics } from '@/lib/plugin-refresh-diagnostics'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { createWorkbenchSessionState } from './workbenchSessionState'

test('restores and persists the active blank chat scope', () => {
  const onStandaloneChatKeyChange = vi.fn()
  const session = createWorkbenchSessionState(
    LOCAL_USER,
    new RuntimeTaskLifecycleStore('standalone-chat-scope-test'),
    false,
    { initialStandaloneChatKey: 4, onStandaloneChatKeyChange }
  )

  expect(session.getSnapshot().state.standaloneChatKey).toBe(4)
  session.dispatch({ type: 'blank_chat_committed', standaloneChatKey: 4 })

  expect(session.getSnapshot().state.standaloneChatKey).toBe(5)
  expect(onStandaloneChatKeyChange).toHaveBeenCalledOnce()
  expect(onStandaloneChatKeyChange).toHaveBeenCalledWith(5)
})

test('settles an E2E refresh observation when its scheduled owner is disposed', () => {
  const activityKey = Symbol.for('wework:e2e:plugin-activity')
  Reflect.deleteProperty(globalThis, activityKey)
  vi.stubGlobal('performance', diagnosticsPerformance)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const namespace = 'wework:plugin-composer-refresh'
  try {
    vi.stubEnv('MODE', 'test')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    expect(beginPluginRefreshDiagnostics('refresh')).toBeUndefined()
    expect(Reflect.has(globalThis, activityKey)).toBe(false)
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const session = createWorkbenchSessionState(
      LOCAL_USER,
      new RuntimeTaskLifecycleStore('disposed-plugin-refresh'),
      false
    )
    const finish = beginPluginRefreshDiagnostics('refresh')!
    session.resources.localAppsRefreshObservationRef.current = finish
    session.resources.localAppsRefreshTimerRef.current = window.setTimeout(() => {
      throw new Error('A disposed refresh must not execute')
    }, 250)
    const started = performance.getEntriesByName(`${namespace}:started`)
    expect(started).toHaveLength(1)
    expect(performance.getEntriesByName(`${namespace}:completed`)).toHaveLength(0)
    expect(Reflect.get(globalThis, activityKey).total.pending).toBe(1)

    session.dispose()
    expect(performance.getEntriesByName(`${namespace}:completed`)).toHaveLength(1)
    finish()
    vi.advanceTimersByTime(250)

    expect(session.resources.localAppsRefreshTimerRef.current).toBeNull()
    expect(session.resources.localAppsRefreshObservationRef.current).toBeNull()
    const completed = performance.getEntriesByName(`${namespace}:completed`) as PerformanceMark[]
    expect(completed).toHaveLength(1)
    expect(completed[0].detail).toBe(started[0].startTime)
    expect(Reflect.get(globalThis, activityKey).total).toEqual({
      started: 1,
      completed: 1,
      failed: 0,
      pending: 0,
    })
  } finally {
    Reflect.deleteProperty(globalThis, activityKey)
    diagnosticsPerformance.clearMarks(`${namespace}:started`)
    diagnosticsPerformance.clearMarks(`${namespace}:completed`)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

test('counts concurrent namespaces independently of colliding timestamps and terminal phase', () => {
  const activityKey = Symbol.for('wework:e2e:plugin-activity')
  Reflect.deleteProperty(globalThis, activityKey)
  const marks: { name: string; startTime: number; detail?: unknown }[] = []
  vi.stubGlobal('performance', {
    mark(name: string, options?: { detail?: unknown }) {
      const mark = { name, startTime: 5, detail: options?.detail }
      marks.push(mark)
      return mark
    },
  })
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  try {
    const completedCatalog = beginPluginRefreshDiagnostics('catalog')!
    const failedCatalog = beginPluginRefreshDiagnostics('catalog')!
    const cancelledRefresh = beginPluginRefreshDiagnostics('refresh')!
    const failedEnrichment = beginPluginRefreshDiagnostics('enrichment')!
    const state = Reflect.get(globalThis, activityKey)
    expect(state.total).toEqual({ started: 4, completed: 0, failed: 0, pending: 4 })

    completedCatalog()
    failedCatalog('failed')
    cancelledRefresh()
    cancelledRefresh('failed')
    failedEnrichment('failed')

    expect(state.total).toEqual({ started: 4, completed: 2, failed: 2, pending: 0 })
    expect(state.byKind.catalog).toEqual({ started: 2, completed: 1, failed: 1, pending: 0 })
    expect(state.byKind.refresh).toEqual({ started: 1, completed: 1, failed: 0, pending: 0 })
    expect(state.byKind.enrichment).toEqual({ started: 1, completed: 0, failed: 1, pending: 0 })
    expect(marks.filter(mark => mark.name.endsWith(':started'))).toHaveLength(4)
    expect(
      marks.filter(mark => !mark.name.endsWith(':started')).map(mark => [mark.name, mark.detail])
    ).toEqual([
      ['wework:plugin-local-catalog:completed', 5],
      ['wework:plugin-local-catalog:failed', 5],
      ['wework:plugin-composer-refresh:completed', 5],
      ['wework:plugin-composer-enrichment:failed', 5],
    ])
  } finally {
    Reflect.deleteProperty(globalThis, activityKey)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})
