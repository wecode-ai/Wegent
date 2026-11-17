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

    await expect(
      copyManagedProfilePlugins(runtime as never, '/profile', ['first-plugin', 'slow-plugin'])
    ).rejects.toThrow('first copy failed')
    expect(finished).toBe(true)
  })
})
