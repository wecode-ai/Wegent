import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveDevUserDataDirectory } from './resolve-dev-user-data.mjs'

describe('resolveDevUserDataDirectory', () => {
  let homeDirectory
  beforeEach(async () => {
    homeDirectory = await mkdtemp(join(tmpdir(), 'wework-dev-user-data-'))
  })
  afterEach(async () => {
    await rm(homeDirectory, { recursive: true, force: true })
  })

  test('isolates the default user data directory by worktree', () => {
    const first = resolveDevUserDataDirectory(join(homeDirectory, 'first'), '', homeDirectory, {
      platform: 'darwin',
    })
    const repeated = resolveDevUserDataDirectory(join(homeDirectory, 'first'), '', homeDirectory, {
      platform: 'darwin',
    })
    const second = resolveDevUserDataDirectory(join(homeDirectory, 'second'), '', homeDirectory, {
      platform: 'darwin',
    })
    const root = join(homeDirectory, 'Library', 'Application Support', 'io.wecode.wework.dev')

    expect(first).toBe(repeated)
    expect(first).not.toBe(second)
    expect(dirname(first)).toBe(root)
    expect(dirname(second)).toBe(root)
  })

  test('preserves an explicit user data directory override', () => {
    expect(
      resolveDevUserDataDirectory(
        join(homeDirectory, 'first'),
        join(homeDirectory, 'custom'),
        homeDirectory
      )
    ).toBe(join(homeDirectory, 'custom'))
  })

  test('reuses the legacy worktree directory to preserve desktop identity', async () => {
    const current = resolveDevUserDataDirectory(join(homeDirectory, 'first'), '', homeDirectory)
    const legacy = join(dirname(current), basename(current).slice(0, 12))
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })

    expect(resolveDevUserDataDirectory(join(homeDirectory, 'first'), '', homeDirectory)).toBe(
      legacy
    )
  })

  test('matches Windows Electron appData without reading personal APPDATA', () => {
    const appDataDirectory = join(homeDirectory, 'roaming')
    const result = resolveDevUserDataDirectory(join(homeDirectory, 'first'), '', homeDirectory, {
      platform: 'win32',
      appDataDirectory,
    })
    expect(dirname(result)).toBe(join(appDataDirectory, 'io.wecode.wework.dev'))
  })
})
