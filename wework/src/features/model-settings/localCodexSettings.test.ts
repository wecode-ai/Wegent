import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getLocalCodexPersonality, saveLocalCodexPersonality } from './localCodexSettings'

const requestLocalExecutor = vi.fn()

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue(undefined),
  requestLocalExecutor: (...args: unknown[]) => requestLocalExecutor(...args),
}))

describe('localCodexSettings', () => {
  beforeEach(() => requestLocalExecutor.mockReset())

  test('reads personality from Codex config', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'friendly' })
    await expect(getLocalCodexPersonality()).resolves.toBe('friendly')
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.personality.read')
  })

  test('writes personality through Codex app-server', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'friendly' })
    await expect(saveLocalCodexPersonality('friendly')).resolves.toBe('friendly')
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.personality.write', {
      personality: 'friendly',
    })
  })

  test('defaults unsupported responses to pragmatic', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'unknown' })
    await expect(getLocalCodexPersonality()).resolves.toBe('pragmatic')
  })
})
