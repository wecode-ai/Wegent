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
  vi.stubGlobal('performance', diagnosticsPerformance)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const namespace = 'wework:plugin-composer-refresh'
  try {
    vi.stubEnv('MODE', 'test')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    expect(beginPluginRefreshDiagnostics('refresh')).toBeUndefined()
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

    session.dispose()
    finish()
    vi.advanceTimersByTime(250)

    expect(session.resources.localAppsRefreshTimerRef.current).toBeNull()
    expect(session.resources.localAppsRefreshObservationRef.current).toBeNull()
    const completed = performance.getEntriesByName(`${namespace}:completed`) as PerformanceMark[]
    expect(completed).toHaveLength(1)
    expect(completed[0].detail).toBe(started[0].startTime)
  } finally {
    diagnosticsPerformance.clearMarks(`${namespace}:started`)
    diagnosticsPerformance.clearMarks(`${namespace}:completed`)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})
