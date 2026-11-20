import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const copy = vi.hoisted(() => ({ plugin: vi.fn() }))

vi.mock('./managed-plugin-files.js', () => ({ copyManagedPlugin: copy.plugin }))

const { copyManagedProfilePlugins } = await import('./core-dsh-runtime.js')

describe('managed profile copy', () => {
  test('waits for every started worker before propagating the first failure', async () => {
    let finished = false
    const runtime = {
      pluginRoots: {
        'first-plugin': '/plugins/first',
        'slow-plugin': '/plugins/slow',
      },
    }
    copy.plugin.mockReset()
    copy.plugin.mockImplementationOnce(async () => {
      throw new Error('first copy failed')
    })
    copy.plugin.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      finished = true
    })
    const profileRoot = await mkdtemp(join(tmpdir(), 'wework-profile-copy-'))

    try {
      await expect(
        copyManagedProfilePlugins(runtime as never, profileRoot, ['first-plugin', 'slow-plugin'])
      ).rejects.toThrow('first copy failed')
      expect(finished).toBe(true)
    } finally {
      await rm(profileRoot, { recursive: true, force: true })
    }
  })
})
