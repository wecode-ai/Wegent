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
    expect(infoMock).toHaveBeenCalledWith('[Wework] Runtime task create diagnostic', {
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
})
