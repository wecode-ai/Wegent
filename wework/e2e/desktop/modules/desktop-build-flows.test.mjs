import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { resolveDesktopCodexBinary } from './desktop-build-flows.mjs'
import { createPreparationObserver } from './preparation-progress.mjs'

test('resolves the per-run coding CLI instead of inheriting another run configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-codex-selection-'))
  const inherited = process.env.WEWORK_E2E_CODEX_BIN
  process.env.WEWORK_E2E_CODEX_BIN = join(root, 'unrelated-codex')
  try {
    assert.equal(
      await resolveDesktopCodexBinary({ WEWORK_E2E_CODEX_BIN: process.execPath }),
      resolve(process.execPath)
    )
  } finally {
    if (inherited === undefined) delete process.env.WEWORK_E2E_CODEX_BIN
    else process.env.WEWORK_E2E_CODEX_BIN = inherited
    await rm(root, { recursive: true, force: true })
  }
})

test('preparation observations retain the operation result and expose only phase metadata', async () => {
  const records = []
  let clock = 10
  let calls = 0
  const result = { token: 'must-not-be-logged' }
  const observe = createPreparationObserver({
    checkpoint: 'harness-app-development',
    now: () => clock,
    write: line => records.push(JSON.parse(line.slice('[desktop-e2e-preparation] '.length))),
  })
  assert.equal(
    await observe('cloud-start', async () => {
      calls++
      clock = 85
      return result
    }),
    result
  )
  assert.equal(calls, 1)
  assert.deepEqual(records, [
    {
      checkpoint: 'harness-app-development',
      stage: 'cloud-start',
      status: 'started',
      elapsedMs: 0,
    },
    {
      checkpoint: 'harness-app-development',
      stage: 'cloud-start',
      status: 'completed',
      elapsedMs: 75,
    },
  ])
  assert.equal(JSON.stringify(records).includes(result.token), false)
})

test('a preparation observer never replaces an operation error with a diagnostic error', async () => {
  const failure = new Error('Original preparation failed')
  let calls = 0
  const observe = createPreparationObserver({
    checkpoint: 'harness-app-development',
    write: () => {
      throw new Error('Diagnostic sink failed')
    },
  })
  await assert.rejects(
    observe('cloud-start', () => {
      calls++
      throw failure
    }),
    error => error === failure
  )
  assert.equal(calls, 1)
  const result = {}
  assert.equal(await observe('successful-start', async () => result), result)
})

test('preparation observations preserve concurrent operations and their independent failures', async () => {
  const started = []
  const records = []
  const observe = createPreparationObserver({
    checkpoint: 'fixture',
    write: value => records.push(value),
  })
  let release
  const pending = new Promise(resolve => {
    release = resolve
  })
  const first = observe('first', async () => {
    started.push('first')
    await pending
    return 'first-result'
  })
  const failure = new Error('Second operation failed')
  const second = observe('second', async () => {
    started.push('second')
    throw failure
  })
  assert.deepEqual(started, ['first', 'second'])
  await assert.rejects(second, error => error === failure)
  release()
  assert.equal(await first, 'first-result')
  assert.equal(records.length, 4)
  assert.equal(
    records.some(value => value.includes(failure.message)),
    false
  )
})
