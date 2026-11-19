import { afterEach, expect, test, vi } from 'vitest'
import { runDesktopControlClient } from './automation'

const native = vi.hoisted(() => ({ invoke: vi.fn(), flush: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/desktopHost')>()),
  invokeDesktopHost: native.invoke,
}))
vi.mock('@/desktop/localStoragePersistence', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/localStoragePersistence')>()),
  flushDesktopLocalStoragePersistence: native.flush,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  native.invoke.mockReset()
  native.flush.mockReset()
})

test.each([true, false])(
  'Core restart waits for a successful result acknowledgement: %s',
  async ok => {
    let acknowledge!: (response: Response) => void
    const acknowledgement = new Promise<Response>(resolve => {
      acknowledge = resolve
    })
    const results: Array<{ id: string; ok: boolean }> = []
    let polls = 0
    native.flush.mockResolvedValue(undefined)
    native.invoke.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/commands?')) {
        return ++polls === 1
          ? Response.json({ id: 'restart', action: 'restartCoreDsh', selector: 'body' })
          : new Response(null, { status: 410 })
      }
      if (url.endsWith('/results')) {
        results.push(JSON.parse(String(init?.body)))
        return acknowledgement
      }
      return Response.json({})
    })
    const running = runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0]).toMatchObject({ id: 'restart', ok: true })
    expect(native.flush).toHaveBeenCalledOnce()
    expect(native.invoke).not.toHaveBeenCalled()
    acknowledge(Response.json({}, { status: ok ? 200 : 500 }))
    await running
    if (ok) {
      expect(native.invoke).toHaveBeenCalledExactlyOnceWith('runtime.restartCoreDsh')
      expect(console.error).not.toHaveBeenCalled()
    } else {
      expect(native.invoke).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith(
        '[Wework] Desktop E2E result acknowledgement failed:',
        expect.any(String)
      )
    }
  }
)
