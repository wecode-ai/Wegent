import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  deletePluginDevelopmentData,
  focusPluginDevelopment,
  openPluginDevelopmentDevTools,
  openPluginDevelopmentLogs,
  pluginDevelopmentInitialInput,
  readPluginDevelopmentSessions,
  restartPluginDevelopmentCoreDsh,
  startPluginDevelopment,
  stopPluginDevelopment,
  subscribePluginDevelopment,
} from './pluginDevelopment'
import { pluginDevelopmentProjectKind } from './pluginDevelopmentProjects'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invoke,
  subscribeDesktopHostEvents: mocks.subscribe,
}))

describe('Core DSH plugin development desktop API', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
    mocks.subscribe.mockReset()
    mocks.subscribe.mockReturnValue(() => {})
  })

  test('uses explicit Electron capabilities for lifecycle operations', async () => {
    await readPluginDevelopmentSessions()
    await startPluginDevelopment('/workspace/plugin')
    await focusPluginDevelopment()
    await openPluginDevelopmentDevTools()
    await restartPluginDevelopmentCoreDsh()
    await openPluginDevelopmentLogs()
    await stopPluginDevelopment()
    await deletePluginDevelopmentData()

    expect(mocks.invoke.mock.calls).toEqual([
      ['pluginDevelopment.list'],
      ['pluginDevelopment.start', { sourceRoot: '/workspace/plugin' }],
      ['pluginDevelopment.focus'],
      ['pluginDevelopment.openDevTools'],
      ['pluginDevelopment.restartCoreDsh'],
      ['pluginDevelopment.openLogDirectory'],
      ['pluginDevelopment.stop'],
      ['pluginDevelopment.deleteData'],
    ])
  })

  test('forwards only plugin development state events', () => {
    const handler = vi.fn()
    subscribePluginDevelopment(handler)
    const subscribed = mocks.subscribe.mock.calls[0]?.[0]

    subscribed({ type: 'browser.event', payload: { ignored: true } })
    subscribed({ type: 'plugin-development.state', payload: { status: 'ready' } })

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ status: 'ready' })
  })

  test('keeps an unobserved project unresolved until host classification arrives', () => {
    expect(pluginDevelopmentProjectKind('/workspace/unobserved-plugin')).toBe('unresolved')
    expect(pluginDevelopmentProjectKind(null)).toBe('standard')
  })

  test('activates the plugin developer plugin in the initial composer input', () => {
    const initialInput = pluginDevelopmentInitialInput('Wework 插件开发', '开发这个 Wework 插件：')

    expect(initialInput).toBe(
      '[$Wework 插件开发](plugin://wework-plugin-developer@wework-personal) 开发这个 Wework 插件：'
    )
    expect(initialInput).not.toContain('skill://')
    expect(initialInput).not.toMatch(/(?:~\/|\/Users\/|[A-Za-z]:\\).*plugins[/\\]cache/)
  })
})
