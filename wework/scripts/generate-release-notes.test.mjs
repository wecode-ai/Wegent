import { describe, expect, test, vi } from 'vitest'
import {
  formatReleaseNote,
  generateReleaseNotes,
  parseReleaseCommits,
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
      [
        'api',
        'repos/example/repo/commits/1234567',
        '--jq',
        '.author.login // empty',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    )
  })

  test('returns no attribution for a successful lookup with no linked author', () => {
    expect(readGitHubAuthorLogin('example/repo', '1234567', () => '')).toBe('')
  })

  test('fails release-note generation when GitHub author lookup fails', () => {
    const error = new Error('GitHub API unavailable')
    expect(() =>
      readGitHubAuthorLogin('example/repo', '1234567', () => {
        throw error
      })
    ).toThrow(error)
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
})
