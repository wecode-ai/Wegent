import { describe, expect, test } from 'vitest'
import { resolvePreviousReleaseTag } from './resolve-previous-release-tag.mjs'

describe('resolve previous release tag', () => {
  test('compares a stable release with the previous stable release', () => {
    expect(
      resolvePreviousReleaseTag({
        tags: ['wework-v1.2.3', 'wework-v1.2.4-beta.1', 'wework-v1.2.4-beta.10', 'wework-v1.2.4'],
        releaseTag: 'wework-v1.2.4',
        releaseChannel: 'stable',
      })
    ).toBe('wework-v1.2.3')
  })

  test('compares a Beta release with the latest release available to Beta users', () => {
    expect(
      resolvePreviousReleaseTag({
        tags: ['wework-v1.2.3-beta.2', 'wework-v1.2.3', 'wework-v1.2.4-beta.1'],
        releaseTag: 'wework-v1.2.4-beta.1',
        releaseChannel: 'beta',
      })
    ).toBe('wework-v1.2.3')
  })

  test('uses the previous Beta when it is newer than the latest stable release', () => {
    expect(
      resolvePreviousReleaseTag({
        tags: ['wework-v1.2.3', 'wework-v1.2.4-beta.1', 'wework-v1.2.4-beta.2'],
        releaseTag: 'wework-v1.2.4-beta.2',
        releaseChannel: 'beta',
      })
    ).toBe('wework-v1.2.4-beta.1')
  })

  test('ignores tags newer than the release being regenerated', () => {
    expect(
      resolvePreviousReleaseTag({
        tags: ['wework-v1.2.3', 'wework-v1.2.4', 'wework-v1.2.5', 'wework-v1.2.6-beta.1'],
        releaseTag: 'wework-v1.2.4',
        releaseChannel: 'stable',
      })
    ).toBe('wework-v1.2.3')
  })

  test('returns an empty baseline for the first release in a channel', () => {
    expect(
      resolvePreviousReleaseTag({
        tags: ['wework-v0.0.1-beta.1'],
        releaseTag: 'wework-v0.0.1-beta.1',
        releaseChannel: 'beta',
      })
    ).toBe('')
  })
})
