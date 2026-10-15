import { describe, expect, it, vi } from 'vitest'
import { setReducedMotion } from './e2e-media-preferences.js'

function target(attached = false) {
  const debuggerSession = {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn(async () => ({})),
  }
  return { isDestroyed: () => false, debugger: debuggerSession }
}

describe('desktop reduced-motion verification', () => {
  it('keeps the media session attached until the system preference is restored', async () => {
    const view = target()
    await setReducedMotion(view, 'no-preference')
    expect(view.debugger.isAttached()).toBe(true)
    await setReducedMotion(view, 'reduce')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await setReducedMotion(view, 'system')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [],
    })
    expect(view.debugger.isAttached()).toBe(false)
  })

  it('preserves a debugger session owned by another inspector', async () => {
    const view = target(true)
    await setReducedMotion(view, 'no-preference')
    await setReducedMotion(view, 'system')
    expect(view.debugger.detach).not.toHaveBeenCalled()
  })

  it('cleans up its debugger session after a failed media override', async () => {
    const view = target()
    view.debugger.sendCommand.mockRejectedValueOnce(new Error('Target closed'))
    await expect(setReducedMotion(view, 'reduce')).rejects.toThrow('Target closed')
    expect(view.debugger.isAttached()).toBe(false)
  })

  it('rejects unsupported media values before attaching a debugger', async () => {
    const view = target()
    await expect(setReducedMotion(view, 'invalid')).rejects.toThrow('Invalid reduced-motion')
    expect(view.debugger.attach).not.toHaveBeenCalled()
  })
})
