import { expect, test, vi } from 'vitest'
import { preparationStep } from './release-preparation.js'
import type { DesktopRelease } from './release-store.js'

const release = { id: 'target', version: '1.1.0' } as DesktopRelease

test('an unavailable diagnostic log does not block release preparation', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const log = { write: vi.fn().mockRejectedValue(new Error('Log directory is read-only')) }
    const prepare = vi.fn().mockResolvedValue('prepared')
    await expect(preparationStep(log, release, 'runtimes', prepare)).resolves.toBe('prepared')
    expect(prepare).toHaveBeenCalledOnce()
    expect(log.write).toHaveBeenCalledTimes(2)
  } finally {
    diagnostic.mockRestore()
  }
})

test('a diagnostic failure preserves the actual preparation failure', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const error = new Error('Required bundled runtime is missing')
    const log = { write: vi.fn().mockRejectedValue(new Error('Log directory is read-only')) }
    await expect(
      preparationStep(log, release, 'runtimes', async () => {
        throw error
      })
    ).rejects.toBe(error)
  } finally {
    diagnostic.mockRestore()
  }
})
