import { describe, expect, test, vi } from 'vitest'
import { exposeStartupShellBridge } from './startup-shell-bridge.js'

function createFixture() {
  const exposeInMainWorld = vi.fn()
  const invoke = vi.fn()
  const off = vi.fn()
  const on = vi.fn()
  return {
    bridge: { exposeInMainWorld },
    exposeInMainWorld,
    invoke,
    off,
    on,
    renderer: { invoke, off, on },
  }
}

describe('startup shell bridge', () => {
  test('exposes startup recovery APIs to the local startup shell', () => {
    const fixture = createFixture()

    exposeStartupShellBridge('file:', fixture.bridge, fixture.renderer)

    const api = fixture.exposeInMainWorld.mock.calls[0]?.[1]
    expect(fixture.exposeInMainWorld).toHaveBeenCalledWith('weworkElectron', api)

    api.getRuntimeState()
    api.reloadDsh()
    expect(fixture.invoke).toHaveBeenNthCalledWith(1, 'runtime:get-state')
    expect(fixture.invoke).toHaveBeenNthCalledWith(2, 'runtime:reload-dsh')

    const listener = vi.fn()
    const dispose = api.onRuntimeChanged(listener)
    const handler = fixture.on.mock.calls[0]?.[1]
    expect(fixture.on).toHaveBeenCalledWith('runtime:changed', handler)

    handler()
    dispose()
    expect(listener).toHaveBeenCalledOnce()
    expect(fixture.off).toHaveBeenCalledWith('runtime:changed', handler)
  })

  test('does not expose startup recovery APIs to the Core DSH page', () => {
    const fixture = createFixture()

    exposeStartupShellBridge('http:', fixture.bridge, fixture.renderer)

    expect(fixture.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
