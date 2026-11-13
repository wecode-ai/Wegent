// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { resolveReleaseVersion } from './resolve-release-version.mjs'

describe('resolveReleaseVersion', () => {
  test('rejects a stable minimum newer than the selected Beta before building', () => {
    expect(() =>
      resolveReleaseVersion({
        tags: ['wework-v0.6.7', 'wework-v0.6.8-beta.5'],
        inputChannel: 'beta',
        minSourceVersion: '0.6.8',
      })
    ).toThrow('0.6.8 > 0.6.8-beta.6')
  })

  test('accepts the published Beta minimum for the next Beta and stable release', () => {
    for (const inputChannel of ['beta', 'stable']) {
      expect(
        resolveReleaseVersion({
          tags: ['wework-v0.6.7', 'wework-v0.6.8-beta.5'],
          inputChannel,
          minSourceVersion: '0.6.8-beta.5',
        }).version
      ).toBe(inputChannel === 'beta' ? '0.6.8-beta.6' : '0.6.8')
    }
  })

  test('validates tagged and explicitly selected targets against the minimum', () => {
    for (const options of [
      { inputVersion: '0.6.7' },
      { githubRef: 'refs/tags/wework-v0.6.8-beta.4', githubRefName: 'wework-v0.6.8-beta.4' },
    ]) {
      expect(() =>
        resolveReleaseVersion({ tags: [], minSourceVersion: '0.6.8-beta.5', ...options })
      ).toThrow('minimum upgrade source cannot be newer')
    }
  })

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

  test('rejects an unknown release channel', () => {
    expect(() =>
      resolveReleaseVersion({
        tags: [],
        inputChannel: 'nightly',
      })
    ).toThrow('Invalid Wework release channel')
  })

  test('rejects an invalid stable version override', () => {
    expect(() =>
      resolveReleaseVersion({
        tags: [],
        inputChannel: 'stable',
        inputVersion: '1.2',
      })
    ).toThrow('Invalid stable Wework version')
  })
})

test('rejects reusing a published stable version for another publication', () => {
  expect(() =>
    resolveReleaseVersion({
      tags: ['wework-v1.2.4'],
      inputChannel: 'stable',
      inputVersion: '1.2.4',
      publishRelease: true,
    })
  ).toThrow('already exists')
})
