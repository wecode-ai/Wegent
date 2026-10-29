import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { windowsBuildKey } from './wework-windows-e2e-build-key.mjs'

const root = new URL('../../', import.meta.url)
const yaml = path =>
  JSON.parse(
    execFileSync(
      'ruby',
      ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', path],
      { cwd: root, encoding: 'utf8' }
    )
  )

test('PR builds and trusted main warmup share exact artifacts and complete native caches', () => {
  const steps = yaml('.github/actions/build-wework-windows-e2e/action.yml').runs.steps
  const restore = steps.find(step => step.id === 'build-cache')
  assert.equal(restore.with['restore-keys'], undefined)
  assert.equal(restore.with.path, 'wework/electron/release/WeWork-win32-x64')
  const save = steps.find(step => step.name === 'Save exact Windows desktop package')
  assert.deepEqual(save.with, restore.with)
  for (const step of steps.filter(step => step.uses?.startsWith('actions/cache/save@'))) {
    assert.ok(step.if.includes("inputs.save-cache == 'true'"))
    assert.ok(step.if.includes("github.ref == 'refs/heads/main'"))
  }
  const dependencies = steps.find(step => step.id === 'dependencies')
  assert.ok(dependencies.with.path.includes('${{ runner.temp }}/executor-target'))
  assert.ok(dependencies.with.path.includes('${{ runner.temp }}/backend-rs-target'))
  for (const name of [
    'Set up Node workspace',
    'Set up sccache',
    'Build Windows Wework Electron E2E application',
    'Build Rust Backend Windows E2E gateway',
  ]) {
    assert.equal(
      steps.find(step => step.name === name).if,
      "steps.build-cache.outputs.cache-hit != 'true'"
    )
  }
  const verify = steps.find(step => step.name === 'Verify complete Windows desktop package')
  assert.equal(verify.if, undefined)
  for (const binary of [
    'WeWork.exe',
    'wegent-executor.exe',
    'wegent-backend-rs.exe',
    'codex.exe',
    'socket.io-client.cjs',
  ]) {
    assert.ok(verify.run.includes(binary))
  }
  for (const step of steps.filter(step => step.run)) assert.ok(step.shell, step.name)

  const workflow = yaml('.github/workflows/wework-e2e.yml')
  const warmup = yaml('.github/workflows/ci-cache-warmup.yml')
  const uses = './.github/actions/build-wework-windows-e2e'
  const consumer = workflow.jobs['build-wework-desktop-windows-core-e2e'].steps.find(
    step => step.uses === uses
  )
  const producer = warmup.jobs['warm-wework-windows-electron']
  assert.equal(consumer.with['save-cache'], "${{ github.ref == 'refs/heads/main' }}")
  assert.ok(producer.if.includes("github.ref == 'refs/heads/main'"))
  assert.equal(producer.steps.find(step => step.uses === uses).with['save-cache'], 'true')
  const source = readFileSync(new URL('../workflows/wework-e2e.yml', import.meta.url), 'utf8')
  assert.ok(source.includes('fromJSON(needs.changes.outputs.windows_desktop_core_e2e_matrix)'))
})

test('Windows package reuse follows build inputs and toolchain, independently of E2E selection', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wework-windows-build-key-'))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
    git('add', path)
  }
  const key = () => windowsBuildKey({ cwd, toolchain: 'windows-x64-node24-rust1-image1' })
  try {
    git('init', '-q')
    write('wework/src/main.ts', 'renderer')
    let before = key()
    write('wework/e2e/scenarios.mjs', 'changed test assertions')
    assert.deepEqual(key(), before)

    for (const input of [
      'wework/src/main.ts',
      'wework/electron/src/main.ts',
      'wework/harness-runtime/plugin.ts',
      'wework/codex-binaries.lock.json',
      'executor/src/main.rs',
      'executor/vendor/dependency/src/lib.rs',
      'backend-rs/src/main.rs',
      'shared/assets/migration.sql',
      'packages/collaboration/src/index.ts',
      'pnpm-lock.yaml',
      '.github/actions/build-wework-windows-e2e/action.yml',
      '.github/scripts/wework-windows-e2e-build-key.mjs',
    ]) {
      write(input, `changed ${input}`)
      const after = key()
      assert.notEqual(after.key, before.key, input)
      assert.equal(after.toolchain, before.toolchain)
      before = after
    }
    const changedToolchain = windowsBuildKey({
      cwd,
      toolchain: 'windows-x64-node24-rust2-image2',
    })
    assert.notEqual(changedToolchain.key, before.key)
    assert.notEqual(changedToolchain.toolchain, before.toolchain)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
