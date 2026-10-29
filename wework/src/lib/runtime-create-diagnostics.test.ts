import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  logRuntimeTaskCreateStage,
  measureRuntimeTaskCreateStage,
} from './runtime-create-diagnostics'

const infoMock = vi.spyOn(console, 'info').mockImplementation(() => undefined)

afterEach(() => vi.unstubAllEnvs())

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

describe('measureRuntimeTaskCreateStage', () => {
  beforeEach(() => {
    infoMock.mockClear()
    vi.stubEnv('MODE', 'test')
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
  })

  it.each(['local-device-resolution', 'local-workspace-resolution'] as const)(
    'measures %s without logging the operation result',
    async stage => {
      const result = { token: 'private-result-token', path: '/private/workspace' }
      let now = 1_000
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      try {
        await expect(
          measureRuntimeTaskCreateStage(stage, async () => {
            now = 2_500
            return result
          })
        ).resolves.toBe(result)
        expect(JSON.parse(infoMock.mock.calls[0][1] as string)).toEqual({
          timestamp: expect.any(String),
          stage,
          startedAt: '1970-01-01T00:00:01.000Z',
          elapsedMs: 1_500,
          status: 'succeeded',
        })
        expect(JSON.stringify(infoMock.mock.calls)).not.toContain('private-result-token')
        expect(JSON.stringify(infoMock.mock.calls)).not.toContain('/private/workspace')
      } finally {
        clock.mockRestore()
      }
    }
  )

  it('preserves the original exception and logs only the failed phase', async () => {
    const error = new Error('Bearer private-exception-token /private/failed-workspace')
    await expect(
      measureRuntimeTaskCreateStage('local-workspace-resolution', async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(JSON.parse(infoMock.mock.calls[0][1] as string)).toMatchObject({
      stage: 'local-workspace-resolution',
      status: 'failed',
    })
    expect(JSON.stringify(infoMock.mock.calls)).not.toContain('private-exception-token')
    expect(JSON.stringify(infoMock.mock.calls)).not.toContain('/private/failed-workspace')
  })

  it('does not collect phase diagnostics outside E2E mode', async () => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    const result = { private: 'result' }
    await expect(
      measureRuntimeTaskCreateStage('local-device-resolution', async () => result)
    ).resolves.toBe(result)
    expect(infoMock).not.toHaveBeenCalled()
  })

  it('does not replace the operation exception when diagnostic delivery fails', async () => {
    const error = new Error('original-operation-error')
    infoMock.mockImplementationOnce(() => {
      throw new Error('diagnostic-delivery-error')
    })
    await expect(
      measureRuntimeTaskCreateStage('local-device-resolution', async () => {
        throw error
      })
    ).rejects.toBe(error)
  })
})
