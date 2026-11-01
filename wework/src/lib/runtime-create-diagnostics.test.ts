import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logRuntimeTaskCreateStage } from './runtime-create-diagnostics'

const infoMock = vi.spyOn(console, 'info').mockImplementation(() => undefined)

describe('logRuntimeTaskCreateStage', () => {
  beforeEach(() => infoMock.mockClear())

  it('writes structured diagnostics to the frontend console', () => {
    logRuntimeTaskCreateStage('hybrid-create-started', {
      taskId: 'runtime-123',
      deviceId: 'cloud-device',
    })
    expect(infoMock).toHaveBeenCalledWith(
      '[Wework] Runtime task create diagnostic',
      expect.any(String)
    )
    expect(JSON.parse(infoMock.mock.calls[0][1] as string)).toEqual({
      timestamp: expect.any(String),
      stage: 'hybrid-create-started',
      taskId: 'runtime-123',
      deviceId: 'cloud-device',
    })
  })

  it('does not reject circular diagnostic details', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => logRuntimeTaskCreateStage('local-payload-built', circular)).not.toThrow()
  })

  it('can retain control stages through debug-panel capture', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      logRuntimeTaskCreateStage('desktop-control-executed', { commandId: 'click-1' }, 'debug')
      expect(debug).toHaveBeenCalledWith(
        '[Wework] Runtime task create diagnostic',
        expect.any(String)
      )
      expect(JSON.parse(debug.mock.calls[0][1] as string)).toMatchObject({
        stage: 'desktop-control-executed',
        commandId: 'click-1',
      })
      expect(infoMock).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
    }
  })
})
