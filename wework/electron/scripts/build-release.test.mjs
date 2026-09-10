import { describe, expect, test, vi } from 'vitest'

import { buildRelease, releaseBuildEnvironments } from './build-release.mjs'

describe('desktop release builds', () => {
  test('does not build an unused host update before componentized updates are active', () => {
    expect(
      releaseBuildEnvironments({
        WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'true',
      })
    ).toEqual([{}])
  })

  test('preserves both release artifacts for local builds without workflow planning', () => {
    expect(releaseBuildEnvironments({})).toEqual([{}, { WEWORK_ONLINE_UPDATE_BUILD: 'true' }])
  })

  test('builds installer and componentized host update in parallel', async () => {
    let releaseFirstBuild = () => {}
    const firstBuild = new Promise(resolve => {
      releaseFirstBuild = resolve
    })
    const runBuild = vi.fn().mockReturnValueOnce(firstBuild).mockResolvedValueOnce(undefined)

    const build = buildRelease(
      {
        WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'false',
        WEWORK_RELEASE_ARCH: 'arm64',
        WEWORK_RELEASE_PLATFORM: 'macos',
      },
      runBuild
    )

    await vi.waitFor(() => expect(runBuild).toHaveBeenCalledTimes(2))
    expect(runBuild.mock.calls.map(call => call[3])).toEqual([
      {},
      { WEWORK_ONLINE_UPDATE_BUILD: 'true' },
    ])
    releaseFirstBuild()
    await build
  })
})
