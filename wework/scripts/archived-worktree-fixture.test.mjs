import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { rewriteGitMarker } from '../e2e/desktop/scenarios/archived-worktree-cleanup.scenario.mjs'
import { isolatedGitEnvironment } from './lib/git-environment.mjs'

test('damages and restores a real worktree Git marker without leaving trailing bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-archive-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  const worktree = join(root, 'worktree')
  // Hooks export repository-local Git variables; the fixture must own its repository.
  const env = isolatedGitEnvironment()
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', env, stdio: 'pipe' }).trim()
  git('init', repository)
  git(
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initialize fixture'
  )
  git('-C', repository, 'worktree', 'add', '--detach', worktree)
  const markerPath = join(worktree, '.git')
  const original = await readFile(markerPath, 'utf8')

  if (process.platform === 'win32') {
    execFileSync('attrib', ['+H', markerPath])
    await assert.rejects(writeFile(markerPath, original), { code: 'EPERM' })
  }

  for (const damaged of [
    'gitdir: missing\n',
    `gitdir: ${join(worktree, 'missing-git/worktrees/fixture')}\n`,
  ]) {
    await rewriteGitMarker(markerPath, damaged)
    assert.equal(await readFile(markerPath, 'utf8'), damaged)
    assert.throws(() => git('-C', worktree, 'rev-parse', '--git-dir'))
    await rewriteGitMarker(markerPath, original)
    assert.equal(await readFile(markerPath, 'utf8'), original)
    assert.equal(git('-C', worktree, 'rev-parse', '--is-inside-work-tree'), 'true')
  }
})

test('refuses to recreate a missing worktree Git marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-archive-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(rewriteGitMarker(join(root, '.git'), 'gitdir: missing\n'), {
    code: 'ENOENT',
  })
})
