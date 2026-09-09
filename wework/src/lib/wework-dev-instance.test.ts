import { afterEach, describe, expect, test, vi } from 'vitest'

describe('Wework development instance information', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    window.history.replaceState({}, '', '/')
    vi.resetModules()
  })

  test('reads plugin development identity from the runtime URL', async () => {
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

  test('keeps build-time development metadata authoritative', async () => {
    vi.stubEnv('VITE_WEWORK_DEV_TITLE', 'Source development')
    vi.stubEnv('VITE_WEWORK_DEV_WORKTREE', '/workspace/source')
    window.history.replaceState(
      {},
      '',
      '/?weworkDevTitle=Plugin%20development&weworkDevWorktree=%2Fworkspace%2Fplugin'
    )
    const { getWeworkDevInstanceInfo } = await import('./wework-dev-instance')

    expect(getWeworkDevInstanceInfo()).toMatchObject({
      title: 'Source development',
      worktree: '/workspace/source',
    })
  })
})
