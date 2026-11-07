import assert from 'node:assert/strict'
import { test } from 'node:test'

import { waitForVoiceToolbarReady } from './voice-toolbar-flow.mjs'

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
