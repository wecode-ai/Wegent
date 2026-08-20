import { describe, expect, test } from 'vitest'
import { hasEmbeddedHttpGitCredentials } from './git-url'

describe('hasEmbeddedHttpGitCredentials', () => {
  test('detects HTTP usernames, passwords, and tokens', () => {
    expect(hasEmbeddedHttpGitCredentials('https://token@github.com/owner/repository.git')).toBe(
      true
    )
    expect(
      hasEmbeddedHttpGitCredentials('https://user:password@github.com/owner/repository.git')
    ).toBe(true)
  })

  test('allows credential-free HTTP and SSH repository URLs', () => {
    expect(hasEmbeddedHttpGitCredentials('https://github.com/owner/repository.git')).toBe(false)
    expect(hasEmbeddedHttpGitCredentials('git@github.com:owner/repository.git')).toBe(false)
    expect(hasEmbeddedHttpGitCredentials('ssh://git@github.com/owner/repository.git')).toBe(false)
  })
})
