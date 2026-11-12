import { describe, expect, it, vi } from 'vitest'
import { DesktopHostReadiness } from './desktop-host-readiness.js'

describe('desktop host initialization before native activation', () => {
  it('holds early native requests until the host services have initialized', async () => {
    const host = new DesktopHostReadiness()
    const createWindow = vi.fn()
    const request = host.wait().then(createWindow)
    await Promise.resolve()
    expect(createWindow).not.toHaveBeenCalled()
    host.complete()
    await request
    expect(createWindow).toHaveBeenCalledOnce()
    await host.wait()
  })

  it('releases every waiting activation with the real initialization failure', async () => {
    const host = new DesktopHostReadiness()
    const error = new Error('IPC initialization failed')
    const first = expect(host.wait()).rejects.toBe(error)
    const second = expect(host.wait()).rejects.toBe(error)
    host.fail(error)
    await Promise.all([first, second])
    await expect(host.wait()).rejects.toBe(error)
    host.complete()
    await expect(host.wait()).rejects.toBe(error)
  })
})
