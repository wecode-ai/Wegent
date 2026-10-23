import assert from 'node:assert/strict'
import { test } from 'vitest'

import { openProjectStandIn } from '../e2e/desktop/modules/stand-in-flows.mjs'

const entry = '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-open"]'

test('project entry waits for the board to mount before clicking', async () => {
  const calls = []
  let mountBoard
  const boardReady = new Promise(resolve => {
    mountBoard = resolve
  })
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      if (action === 'waitFor' && selector === entry) await boardReady
      if (action === 'getValue') return 'default'
    },
  }

  const opened = openProjectStandIn(control, entry)
  assert.deepEqual(calls, [['waitFor', entry]])
  mountBoard()
  await opened

  assert.deepEqual(calls.slice(0, 2), [
    ['waitFor', entry],
    ['click', entry],
  ])
  assert.deepEqual(calls.at(-1), ['waitFor', '[data-testid="stand-in-prompt"]'])
})

test('missing project entry remains a checkpoint failure without clicking', async () => {
  const calls = []
  const missingEntry = new Error('The project board did not mount')
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      throw missingEntry
    },
  }

  await assert.rejects(openProjectStandIn(control, entry), error => error === missingEntry)
  assert.deepEqual(calls, [['waitFor', entry]])
})
