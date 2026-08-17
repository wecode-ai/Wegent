import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logRuntimeTaskCreateStage } from './runtime-create-diagnostics'

const mocks = vi.hoisted(() => ({
  writeInfoLog: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-log', () => ({
  info: mocks.writeInfoLog,
}))

describe('logRuntimeTaskCreateStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeInfoLog.mockResolvedValue(undefined)
  })

  it('writes structured diagnostics to the persisted frontend log', () => {
    logRuntimeTaskCreateStage('hybrid-create-started', {
      taskId: 'runtime-123',
      deviceId: 'cloud-device',
    })

    expect(mocks.writeInfoLog).toHaveBeenCalledWith(
      '[Wework] Runtime task create diagnostic ' +
        '{"stage":"hybrid-create-started","taskId":"runtime-123","deviceId":"cloud-device"}'
    )
  })

  it('does not reject the runtime flow when persisted logging fails', async () => {
    mocks.writeInfoLog.mockRejectedValue(new Error('log unavailable'))

    expect(() =>
      logRuntimeTaskCreateStage('local-rpc-dispatched', {
        taskId: 'runtime-123',
      })
    ).not.toThrow()
    await Promise.resolve()
  })

  it('falls back to the stage when details cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    logRuntimeTaskCreateStage('local-payload-built', circular)

    expect(mocks.writeInfoLog).toHaveBeenCalledWith(
      '[Wework] Runtime task create diagnostic ' +
        '{"stage":"local-payload-built","serializationFailed":true}'
    )
  })
})
