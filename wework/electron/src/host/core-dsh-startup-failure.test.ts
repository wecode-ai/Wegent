import { describe, expect, test, vi } from 'vitest'
import { detectCoreDshStartupPluginFailure, detectionScript } from './core-dsh-startup-failure.js'

describe('Core DSH startup failure detection', () => {
  test('accepts only an exact enabled plugin candidate returned by the page', async () => {
    const executeJavaScript = vi.fn(async () => '@wegent/ai-fleet-defense')

    await expect(
      detectCoreDshStartupPluginFailure({ executeJavaScript }, [
        '@wegent/ai-fleet-defense',
        '@wegent/other-plugin',
      ])
    ).resolves.toBe('@wegent/ai-fleet-defense')

    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"[data-dsh-boot]"'))
  })

  test('rejects page text that is not one of the recoverable plugins', async () => {
    await expect(
      detectCoreDshStartupPluginFailure(
        { executeJavaScript: async () => '@wegent/dsh-app-wework' },
        ['@wegent/ai-fleet-defense']
      )
    ).resolves.toBeNull()
  })

  test('observes the DSH boot failure contract and exact element text', () => {
    const script = detectionScript(['@wegent/ai-fleet-defense'])

    expect(script).toContain('Failed to load plugins')
    expect(script).toContain("root.querySelectorAll('*')")
    expect(script).toContain('texts.has(name)')
    expect(script).toContain('@wegent/ai-fleet-defense')
  })
})
