import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { replyPredictionShellIdentityCommand } from '../e2e/desktop/scenarios/reply-prediction-auth.scenario.mjs'

const ENV_OK = 'PREDICTION_PARENT_SHELL_IDENTITY_OK'

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'reply-shell-identity-'))
  try {
    const workspace = join(root, "Task ' & $ 北京")
    await mkdir(workspace)
    await run({ root, workspace })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function runIdentity({ cwd, workspace = cwd, executor = process.execPath, env = {} }) {
  const windows = process.platform === 'win32'
  const command = replyPredictionShellIdentityCommand()
  const result = spawnSync(
    windows ? 'powershell.exe' : '/bin/sh',
    windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        WEGENT_EXECUTOR_BINARY: executor,
        WEGENT_TASK_WORKSPACE: workspace,
        ...env,
      },
      timeout: 5_000,
    }
  )
  assert.equal(result.error, undefined)
  return result
}

test('the real shell verifies an executable and its exact Task workspace across quoted paths', async () => {
  await withWorkspace(async ({ workspace }) => {
    const result = runIdentity({ cwd: workspace })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), ENV_OK)
  })
})

test('workspace identity uses the real directory rather than its symlink spelling', async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const alias = join(root, 'Task alias')
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const result = runIdentity({ cwd: workspace, workspace: alias })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), ENV_OK)
  })
})

test('checks shell identity without launching another lifecycle-controlled sidecar', async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const preload = join(root, 'reject-child-executor.cjs')
    await writeFile(
      preload,
      `require('node:child_process').spawnSync = () => { throw new Error('An identity check must not launch a sidecar') }`
    )
    const result = runIdentity({
      cwd: workspace,
      env: {
        WEGENT_APP_LIFECYCLE_FD: '9999',
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), ENV_OK)
  })
})

test.skipIf(process.platform === 'win32')(
  'rejects a file without executable permission',
  async () => {
    await withWorkspace(async ({ root, workspace }) => {
      const executor = join(root, 'non-executable')
      await writeFile(executor, 'not executable', { mode: 0o644 })
      const result = runIdentity({ cwd: workspace, executor })

      assert.notEqual(result.status, 0)
      assert.ok(!result.stdout.includes(ENV_OK))
    })
  }
)

test.each([
  'missing executor',
  'unknown executor',
  'directory executor',
  'missing workspace',
  'wrong cwd',
])('does not report a verified parent shell with %s', async invalid => {
  await withWorkspace(async ({ root, workspace }) => {
    const options = { cwd: workspace }
    if (invalid === 'missing executor') options.executor = ''
    if (invalid === 'unknown executor') options.executor = join(root, 'missing-executor')
    if (invalid === 'directory executor') options.executor = workspace
    if (invalid === 'missing workspace') options.workspace = ''
    if (invalid === 'wrong cwd') options.workspace = root
    const result = runIdentity(options)

    assert.notEqual(result.status, 0)
    assert.ok(!result.stdout.includes(ENV_OK), 'A failed check must not verify the shell')
  })
})
