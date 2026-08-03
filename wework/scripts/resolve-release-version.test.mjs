import { describe, expect, test } from 'vitest'
import { resolveReleaseVersion } from './resolve-release-version.mjs'

describe('resolveReleaseVersion', () => {
  test('starts the next patch Beta without a version input', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.3'],
        inputChannel: 'beta',
        inputVersion: '9.9.9',
      })
    ).toMatchObject({
      version: '1.2.4-beta.1',
      channel: 'beta',
      prerelease: true,
    })
  })

  test('increments the latest Beta number', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.3', 'wework-v1.2.4-beta.2', 'wework-v1.2.4-beta.10'],
        inputChannel: 'beta',
      }).version
    ).toBe('1.2.4-beta.11')
  })

  test('starts a new Beta patch after the matching stable release', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.4-beta.3', 'wework-v1.2.4'],
        inputChannel: 'beta',
      }).version
    ).toBe('1.2.5-beta.1')
  })

  test('supports an optional stable override', () => {
    expect(
      resolveReleaseVersion({
        tags: ['wework-v1.2.4'],
        inputChannel: 'stable',
        inputVersion: 'v2.0.0',
      }).version
    ).toBe('2.0.0')
  })

  test('derives a Beta channel when rerunning an existing tag', () => {
    expect(
      resolveReleaseVersion({
        tags: [],
        githubRef: 'refs/tags/wework-v1.3.0-beta.4',
        githubRefName: 'wework-v1.3.0-beta.4',
      })
    ).toEqual({
      version: '1.3.0-beta.4',
      channel: 'beta',
      releaseTag: 'wework-v1.3.0-beta.4',
      prerelease: true,
      publishRelease: true,
    })
  })
})
