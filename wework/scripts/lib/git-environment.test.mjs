import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isolatedGitEnvironment } from './git-environment.mjs'

test('nested repository commands cannot inherit the hook repository or mutate its config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-git-environment-'))
  // Fixture setup must stay independent of the sanitizer under test.
  const neutral = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  )
  const git = (args, env = neutral) =>
    execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    const parent = join(root, 'parent')
    const child = join(root, 'child')
    await mkdir(child)
    git(['init', parent])
    git(['-C', parent, 'config', '--local', 'core.autocrlf', 'input'])
    const polluted = {
      ...neutral,
      GIT_DIR: join(parent, '.git'),
      GIT_COMMON_DIR: join(parent, '.git'),
      GIT_WORK_TREE: parent,
      GIT_INDEX_FILE: join(parent, '.git', 'index'),
    }
    const env = isolatedGitEnvironment(polluted)
    git(['init', child], env)
    git(['-C', child, 'config', '--local', 'core.autocrlf', 'true'], env)
    expect(git(['-C', parent, 'config', '--get', 'core.autocrlf'])).toBe('input')
    expect(git(['-C', parent, 'config', '--get', 'core.bare'])).toBe('false')
    expect(await realpath(git(['-C', child, 'rev-parse', '--show-toplevel'], env))).toBe(
      await realpath(child)
    )
    expect(polluted.GIT_DIR).toBe(join(parent, '.git'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
