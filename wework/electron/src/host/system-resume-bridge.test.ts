import { describe, expect, test, vi } from 'vitest'
import { SystemResumeBridge } from './system-resume-bridge.js'

describe('SystemResumeBridge', () => {
  test('broadcasts resume events to every live renderer', () => {
    let resumeListener: (() => void) | null = null
    const source = {
      on: vi.fn((_event: 'resume', listener: () => void) => {
        resumeListener = listener
      }),
      off: vi.fn(),
    }
    const liveTarget = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    }
    const destroyedTarget = {
      isDestroyed: vi.fn(() => true),
      send: vi.fn(),
    }
    const bridge = new SystemResumeBridge(source, () => [liveTarget, destroyedTarget])

    bridge.start()
    resumeListener?.()

    expect(liveTarget.send).toHaveBeenCalledWith('system:resume')
    expect(destroyedTarget.send).not.toHaveBeenCalled()
  })

  test('registers once and removes the listener when stopped', () => {
    const source = {
      on: vi.fn(),
      off: vi.fn(),
    }
    const bridge = new SystemResumeBridge(source, () => [])

    bridge.start()
    bridge.start()
    bridge.stop()
    bridge.stop()

    expect(source.on).toHaveBeenCalledTimes(1)
    expect(source.off).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(source.off).toHaveBeenCalledTimes(1)
  })
})
