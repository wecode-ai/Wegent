import { afterEach, describe, expect, test, vi } from 'vitest'

describe('Wework development instance information', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    window.history.replaceState({}, '', '/')
    vi.resetModules()
  })

  test('reads plugin development identity from the runtime URL', async () => {
    vi.stubEnv('VITE_WEWORK_DEV_TITLE', '')
    vi.stubEnv('VITE_WEWORK_DEV_WORKTREE', '')
    window.history.replaceState(
      {},
      '',
      '/?weworkDevTitle=Example%20plugin&weworkDevWorktree=%2Fworkspace%2Fplugin'
    )
    const { getWeworkDevInstanceInfo } = await import('./wework-dev-instance')

    expect(getWeworkDevInstanceInfo()).toMatchObject({
      title: 'Example plugin',
      worktree: '/workspace/plugin',
    })
  })
})
