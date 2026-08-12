import { describe, expect, test, vi } from 'vitest'
import {
  findPreviousReleaseRef,
  formatReleaseNote,
  formatReleaseNotesDocument,
  generateReleaseNotes,
  parseReleaseCommits,
  readReleaseCommits,
  readGitHubAuthorLogin,
} from './generate-release-notes.mjs'

describe('generate release notes', () => {
  test('parses git log records', () => {
    expect(
      parseReleaseCommits(
        [
          '1234567890abcdef\u001ffeat(wework): add changelog (#42)',
          'abcdef1234567890\u001ffix(executor): preserve output',
        ].join('\n')
      )
    ).toEqual([
      {
        sha: '1234567890abcdef',
        subject: 'feat(wework): add changelog (#42)',
      },
      {
        sha: 'abcdef1234567890',
        subject: 'fix(executor): preserve output',
      },
    ])
  })

  test('formats pull request changes with a GitHub contributor', () => {
    expect(
      formatReleaseNote({
        sha: '1234567890abcdef',
        subject: 'feat(wework): add changelog (#42)',
        authorLogin: 'contributor',
      })
    ).toBe('- feat(wework): add changelog by @contributor in #42')
  })

  test('keeps direct commit hashes and contributor attribution', () => {
    expect(
      formatReleaseNote({
        sha: 'abcdef1234567890',
        subject: 'fix(executor): preserve output',
        authorLogin: 'maintainer',
      })
    ).toBe('- fix(executor): preserve output by @maintainer (abcdef1)')
  })

  test('continues without attribution when GitHub has no linked account', () => {
    expect(
      formatReleaseNote({
        sha: 'abcdef1234567890',
        subject: 'fix(wework): repair updater (#99)',
      })
    ).toBe('- fix(wework): repair updater in #99')
  })

  test('attributes only the GitHub commit author', () => {
    const runCommand = vi.fn(() => 'contributor\n')

    expect(readGitHubAuthorLogin('example/repo', '1234567', runCommand)).toBe('contributor')
    expect(runCommand).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/example/repo/commits/1234567', '--jq', '.author.login // empty'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    )
  })

  test('returns no attribution for a successful lookup with no linked author', () => {
    expect(readGitHubAuthorLogin('example/repo', '1234567', () => '')).toBe('')
  })

  test('retries transient GitHub author lookup failures with exponential backoff', () => {
    const error = new Error('TLS certificate verification failed')
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockImplementationOnce(() => {
        throw error
      })
      .mockReturnValue('contributor\n')
    const sleep = vi.fn()
    const log = vi.fn()

    expect(
      readGitHubAuthorLogin('example/repo', '1234567', runCommand, {
        retryDelayMs: 25,
        sleep,
        log,
      })
    ).toBe('contributor')
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 25)
    expect(sleep).toHaveBeenNthCalledWith(2, 50)
    expect(log).toHaveBeenCalledTimes(2)
  })

  test('fails release-note generation when GitHub author lookup fails', () => {
    const error = new Error('GitHub API unavailable')
    const runCommand = vi.fn(() => {
      throw error
    })
    const sleep = vi.fn()
    expect(() =>
      readGitHubAuthorLogin('example/repo', '1234567', runCommand, {
        attempts: 3,
        retryDelayMs: 0,
        sleep,
        log: vi.fn(),
      })
    ).toThrow(error)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  test('resolves each commit author while preserving release order', () => {
    const resolveAuthorLogin = vi.fn(sha => (sha.startsWith('1') ? 'alice' : 'bob'))

    expect(
      generateReleaseNotes(
        [
          {
            sha: '1234567890abcdef',
            subject: 'feat(wework): add changelog (#42)',
          },
          {
            sha: 'abcdef1234567890',
            subject: 'fix(executor): preserve output',
          },
        ],
        resolveAuthorLogin
      )
    ).toBe(
      [
        '- feat(wework): add changelog by @alice in #42',
        '- fix(executor): preserve output by @bob (abcdef1)',
      ].join('\n')
    )
    expect(resolveAuthorLogin).toHaveBeenCalledTimes(2)
  })

  test('reads commits after the previous release reference', () => {
    const runCommand = vi.fn(() => '1234567890abcdef\u001ffeat(wework): add changelog')

    expect(readReleaseCommits('previous-release', 'release-sha', runCommand)).toEqual([
      {
        sha: '1234567890abcdef',
        subject: 'feat(wework): add changelog',
      },
    ])
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      [
        'log',
        '--no-merges',
        '--pretty=format:%H%x1f%s',
        'previous-release..release-sha',
        '--',
        'wework/',
        'executor/',
      ],
      { encoding: 'utf8' }
    )
  })

  test('finds the previous stable release for a stable version', () => {
    const runCommand = vi.fn(() =>
      [
        'current\u001fchore(wework): bump app version to 0.1.14',
        'duplicate\u001fchore(wework): bump app version to 0.1.14',
        'beta\u001fchore(wework): bump app version to 0.1.14-beta.1',
        'previous\u001fchore(wework): bump app version to 0.1.13',
      ].join('\n')
    )

    expect(findPreviousReleaseRef('0.1.14', 'release-sha', runCommand)).toBe('previous')
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      [
        'log',
        '--pretty=format:%H%x1f%s',
        'release-sha',
        '--',
        'wework/package.json',
        'wework/src-tauri/tauri.conf.json',
      ],
      { encoding: 'utf8' }
    )
  })

  test('finds the previous beta release for a beta version', () => {
    expect(
      findPreviousReleaseRef('0.1.14-beta.2', 'release-sha', () =>
        [
          'current\u001fchore(wework): bump app version to 0.1.14-beta.2',
          'previous\u001fchore(wework): bump app version to 0.1.14-beta.1',
          'stable\u001fchore(wework): bump app version to 0.1.13',
        ].join('\n')
      )
    ).toBe('previous')
  })

  test('uses the latest version bump when the requested version has not been committed', () => {
    expect(
      findPreviousReleaseRef(
        '0.1.15-beta.1',
        'release-sha',
        () => 'previous\u001fchore(wework): bump app version to 0.1.14'
      )
    ).toBe('previous')
  })

  test('formats generated changes as the MinIO changelog document', () => {
    expect(formatReleaseNotesDocument('- feat(wework): add changelog')).toBe(
      '## Changes\n\n- feat(wework): add changelog'
    )
    expect(formatReleaseNotesDocument('')).toContain('No Wework app bundle changes detected')
  })
})
