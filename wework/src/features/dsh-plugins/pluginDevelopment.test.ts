// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { subscribePluginDevelopment } from './pluginDevelopment'

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

  test('forwards only plugin development state events', () => {
    const handler = vi.fn()
    subscribePluginDevelopment(handler)
    const subscribed = mocks.subscribe.mock.calls[0]?.[0]

    subscribed({ type: 'browser.event', payload: { ignored: true } })
    subscribed({ type: 'plugin-development.state', payload: { status: 'ready' } })

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ status: 'ready' })
  })
})
