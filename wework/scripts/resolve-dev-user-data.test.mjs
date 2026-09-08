import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveDevUserDataDirectory } from './resolve-dev-user-data.mjs'

describe('resolveDevUserDataDirectory', () => {
  test('isolates the default user data directory by worktree', () => {
    const homeDirectory = '/Users/example'
    const first = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)
    const repeated = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)
    const second = resolveDevUserDataDirectory('/worktrees/second', '', homeDirectory)
    const root = join(homeDirectory, 'Library', 'Application Support', 'io.wecode.wework.dev')

    expect(first).toBe(repeated)
    expect(first).not.toBe(second)
    expect(first.startsWith(`${root}/`)).toBe(true)
    expect(second.startsWith(`${root}/`)).toBe(true)
  })

  test('preserves an explicit user data directory override', () => {
    expect(
      resolveDevUserDataDirectory('/worktrees/first', './custom-user-data', '/Users/example')
    ).toBe(resolve('./custom-user-data'))
  })

  test('reuses the legacy worktree directory to preserve desktop identity', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'wework-dev-user-data-'))
    try {
      const current = resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)
      const legacy = join(dirname(current), basename(current).slice(0, 12))
      await mkdir(current, { recursive: true })
      await mkdir(legacy, { recursive: true })

      expect(resolveDevUserDataDirectory('/worktrees/first', '', homeDirectory)).toBe(legacy)
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })
})
