import { describe, expect, it } from 'vitest'
import {
  gitAccountSettingsUrl,
  gitRepositoryDomain,
  needsGitConfiguration,
  parseGitAccessFailure,
} from './git-access'

describe('Git access protocol', () => {
  it('decodes diagnostics through initialization stage prefixes', () => {
    const failure = {
      code: 'credentials-required',
      domain: 'git.example:8443',
      message: 'Configure Git',
    }
    const parsed = parseGitAccessFailure(
      new Error(`Failed to prepare project repositories: git-access:${JSON.stringify(failure)}`)
    )
    expect(parsed).toEqual(failure)
    expect(needsGitConfiguration(parsed)).toBe(true)
    expect(needsGitConfiguration({ ...failure, code: 'repository-inaccessible' })).toBe(false)
    const ssh = parseGitAccessFailure(
      `git-access:${JSON.stringify({ ...failure, code: 'ssh-authentication-failed' })}`
    )
    expect(ssh?.code).toBe('ssh-authentication-failed')
    expect(needsGitConfiguration(ssh)).toBe(false)
    for (const message of ['git-access:{"code":"evil"}', 'git-access:broken', 'ordinary error']) {
      expect(parseGitAccessFailure(message)).toBeUndefined()
    }
  })

  it('routes to the configured deployment without authentication data', () => {
    const url = new URL(
      gitAccountSettingsUrl(
        {
          webUrl: 'https://web.example/wegent?auth=private#old',
          backendUrl: 'https://wrong.example',
        },
        'git.example:8443'
      )!
    )
    expect(url.origin).toBe('https://web.example')
    expect(url.pathname).toBe('/wegent/settings')
    expect(url.searchParams.get('gitDomain')).toBe('git.example:8443')
    expect(url.searchParams.get('auth')).toBeNull()
    expect(url.hash).toBe('#git-accounts')
    expect(gitAccountSettingsUrl({ webUrl: 'file:///tmp' })).toBeNull()
    expect(gitAccountSettingsUrl({})).toBeNull()
  })

  it('uses exact host and port, preserving native filesystem paths', () => {
    expect(gitRepositoryDomain('git@github.com:owner/repo.git')).toBe('github.com')
    expect(gitRepositoryDomain('https://git.example:8443/repo')).toBe('git.example:8443')
    expect(gitRepositoryDomain('https://git.example:443/repo')).toBe('git.example:443')
    expect(gitRepositoryDomain('C:\\workspace\\repo')).toBe('')
    expect(gitRepositoryDomain('/tmp/repo')).toBe('')
  })
})
