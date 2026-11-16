import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  cleanupFailureDiagnostics,
  rewriteGitMarker,
} from '../e2e/desktop/scenarios/archived-worktree-cleanup.scenario.mjs'

test('cleanup diagnostics preserve remaining paths and process identities without launch details', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cleanup-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'remaining.txt'), 'fixture')
  const control = {
    async command(action) {
      assert.equal(action, 'getOwnedProcessSnapshot')
      return JSON.stringify({
        capturedAt: 123,
        collectingSystemProcesses: false,
        degraded: [],
        processes: [
          {
            pid: 42,
            parentPid: 1,
            name: 'codex.exe',
            kind: 'host-service',
            owner: { id: 'executor', label: 'Private label' },
            detail: 'Private command line',
          },
        ],
      })
    },
  }
  const diagnostics = await cleanupFailureDiagnostics(control, root)
  assert.deepEqual(diagnostics.remainingEntries, ['remaining.txt'])
  assert.deepEqual(diagnostics.ownedProcesses.processes, [
    {
      pid: 42,
      parentPid: 1,
      name: 'codex.exe',
      kind: 'host-service',
      ownerId: 'executor',
    },
  ])
  assert.ok(!JSON.stringify(diagnostics).includes('Private'))
})

test('diagnostic collection failures cannot replace the original cleanup failure', async () => {
  const control = {
    command: async () => {
      throw new Error('Control disconnected')
    },
  }
  const diagnostics = await cleanupFailureDiagnostics(control, import.meta.filename)
  assert.equal(typeof diagnostics.remainingEntries.error, 'string')
  assert.deepEqual(diagnostics.ownedProcesses, { error: 'Control disconnected' })
})

test('damages and restores a real worktree Git marker without leaving trailing bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-archive-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  const worktree = join(root, 'worktree')
  // Hooks export repository-local Git variables; the fixture must own its repository.
  const env = { ...process.env }
  const localVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
  })
  for (const name of localVariables.trim().split(/\r?\n/)) delete env[name]
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
