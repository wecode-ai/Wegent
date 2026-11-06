import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureFailureFollowup, failureFollowupDelayMs } from './failure-followup.mjs'
import { waitForVoiceToolbarReady } from './voice-toolbar-flow.mjs'

function controlReturning(uiSnapshot, workbenchDebug) {
  const commands = []
  return {
    commands,
    command: async (action, selector, options) => {
      commands.push({ action, selector, options })
      if (action === 'snapshot') return JSON.stringify(uiSnapshot)
      if (action === 'getWorkbenchDebugSnapshot') return JSON.stringify(workbenchDebug)
      throw new Error(`Unexpected control command: ${action}`)
    },
  }
}

test('resolves the follow-up delay from the environment with a safe default', () => {
  assert.equal(failureFollowupDelayMs(undefined), 3_000)
  assert.equal(failureFollowupDelayMs(''), 3_000)
  assert.equal(failureFollowupDelayMs('0'), 0)
  assert.equal(failureFollowupDelayMs('5000'), 5_000)
  assert.equal(failureFollowupDelayMs('12000'), 5_000)
  assert.equal(failureFollowupDelayMs('Infinity'), 3_000)
  assert.equal(failureFollowupDelayMs('not-a-number'), 3_000)
  assert.equal(failureFollowupDelayMs('-5'), 3_000)
})

test('captures post-failure UI and workbench state with metadata', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = controlReturning(
      { testIds: ['collaboration-project-execution-environment-add'] },
      { workbench: { isBootstrapping: false } }
    )
    const followup = await captureFailureFollowup(control, resultDir, 0)
    assert.equal(followup, null)
    assert.deepEqual(control.commands, [])

    const captured = await captureFailureFollowup(control, resultDir, 1)
    assert.equal(captured.delayMs, 1)
    assert.equal(captured.budgetMs, 10_000)
    assert.equal(captured.uiSnapshot.testIds.length, 1)
    assert.equal(captured.workbenchDebug.workbench.isBootstrapping, false)
    assert.deepEqual(
      control.commands.map(command => command.action),
      ['snapshot', 'getWorkbenchDebugSnapshot']
    )
    const stored = JSON.parse(await readFile(join(resultDir, 'failure-followup.json'), 'utf8'))
    assert.equal(stored.delayMs, 1)
    assert.ok(stored.capturedAt)
    assert.deepEqual(stored.uiSnapshot, captured.uiSnapshot)
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('caps an explicitly supplied observation delay at five seconds', async t => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const control = controlReturning({ testIds: [] }, { workbench: {} })
    const pending = captureFailureFollowup(control, resultDir, 12_000)
    t.mock.timers.tick(4_999)
    assert.deepEqual(control.commands, [])
    t.mock.timers.tick(1)
    const captured = await pending
    assert.equal(captured.delayMs, 5_000)
    assert.equal(control.commands.length, 2)
  } finally {
    t.mock.timers.reset()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a hanging control client cannot extend the follow-up past its overall deadline', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = {
      command: () => new Promise(() => {}),
    }
    const startedAt = Date.now()
    await assert.rejects(
      captureFailureFollowup(control, resultDir, 1),
      /exceeded its overall deadline/
    )
    const elapsed = Date.now() - startedAt
    assert.ok(
      elapsed < 12_000,
      `The follow-up must stay bounded by its deadline, took ${elapsed}ms`
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a follow-up capture failure rejects so callers keep the original error separate', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = {
      command: async () => {
        throw new Error('The WebView can no longer answer diagnostics')
      },
    }
    await assert.rejects(captureFailureFollowup(control, resultDir, 1), /no longer answer/)
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('voice readiness keeps the original wait and does not collect diagnostics on success', async () => {
  const commands = []
  await waitForVoiceToolbarReady({ command: async (...args) => commands.push(args) }, () =>
    assert.fail('Successful readiness must not emit failure diagnostics')
  )
  assert.deepEqual(commands, [
    ['waitFor', '[data-testid="composer-voice-input"] button:not([aria-haspopup])'],
  ])
})

test('voice failure records bounded toolbar attributes and rethrows the same error without retry', async () => {
  const failure = new Error('The official voice provider did not become ready')
  const calls = []
  const reports = []
  const control = {
    command: async (...args) => {
      calls.push(args)
      if (args[0] === 'waitFor') throw failure
      if (args[0] === 'getElementCount') return 1
      return args[2].value === 'aria-haspopup' ? 'dialog' : 'x'.repeat(400)
    },
  }
  await assert.rejects(
    waitForVoiceToolbarReady(control, value => reports.push(value)),
    error => error === failure
  )
  assert.equal(calls.filter(([action]) => action === 'waitFor').length, 1)
  assert.equal(reports.length, 1)
  const state = JSON.parse(reports[0].slice('[voice-toolbar-readiness] '.length))
  assert.equal(state.popup, 'dialog')
  assert.equal(state.mounted, '1')
  assert.equal(state.label.length, 256)
  assert.equal(state.title.length, 256)
})

test('voice diagnostic read or log failures never replace the readiness failure', async () => {
  const failure = new Error('Voice readiness failed')
  for (const failRead of [true, false]) {
    const control = {
      command: async action => {
        if (action === 'waitFor') throw failure
        if (failRead) throw new Error('The control client disconnected')
        return 0
      },
    }
    await assert.rejects(
      waitForVoiceToolbarReady(control, () => {
        throw new Error('The diagnostic sink is unavailable')
      }),
      error => error === failure
    )
  }
})
