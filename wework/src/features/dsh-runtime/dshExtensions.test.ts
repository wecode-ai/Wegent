import { afterEach, describe, expect, test, vi } from 'vitest'

import type { WeworkExtensionHost } from '../../../dsh/app-wework/client'
import { DSH_EXTENSION_HOST_CHANGE_EVENT, subscribeDshTelemetrySinks } from './dshExtensions'

function fakeHost() {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => unsubscribe)
  return {
    host: { telemetry: { sinks: { subscribe } } } as unknown as WeworkExtensionHost,
    subscribe,
    unsubscribe,
  }
}

describe('subscribeDshTelemetrySinks', () => {
  afterEach(() => {
    delete window.__WEWORK_DSH_EXTENSIONS__
  })

  test('attaches when the DSH host appears later and flushes on bind', () => {
    const listener = vi.fn()
    const stop = subscribeDshTelemetrySinks(listener)
    expect(listener).not.toHaveBeenCalled()

    const first = fakeHost()
    window.__WEWORK_DSH_EXTENSIONS__ = first.host
    window.dispatchEvent(new Event(DSH_EXTENSION_HOST_CHANGE_EVENT))

    expect(first.subscribe).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)

    const second = fakeHost()
    window.__WEWORK_DSH_EXTENSIONS__ = second.host
    window.dispatchEvent(new Event(DSH_EXTENSION_HOST_CHANGE_EVENT))

    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(second.subscribe).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)

    stop()
    expect(second.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
