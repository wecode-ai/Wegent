import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  openCollaborationNotifications,
  openProjectStandIn,
} from '../e2e/desktop/modules/stand-in-flows.mjs'

const entry = '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-open"]'

test('project entry waits for the board to mount before clicking', async () => {
  const calls = []
  let clicked = false
  let mountBoard
  const boardReady = new Promise(resolve => {
    mountBoard = resolve
  })
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      if (action === 'clickWhenEnabled' && selector === entry) {
        await boardReady
        clicked = true
      }
      if (action === 'getValue') return 'default'
    },
  }

  const opened = openProjectStandIn(control, entry)
  assert.deepEqual(calls, [['clickWhenEnabled', entry]])
  assert.equal(clicked, false)
  mountBoard()
  await opened

  assert.deepEqual(calls.slice(0, 2), [
    ['clickWhenEnabled', entry],
    ['waitFor', '[data-testid="stand-in-project-select"]'],
  ])
  assert.equal(clicked, true)
  assert.deepEqual(
    calls.filter(([, selector]) => selector === entry),
    [['clickWhenEnabled', entry]]
  )
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
  assert.deepEqual(calls, [['clickWhenEnabled', entry]])
})

test('notification entry waits for the reloaded shell and category before clicking', async () => {
  const calls = []
  let mountShell
  const shellReady = new Promise(resolve => {
    mountShell = resolve
  })
  const notificationEntry = '[data-testid="wework-notifications-button"]'
  const category = '[data-testid="wework-notifications-category-collaboration"]'
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      if (action === 'clickWhenEnabled' && selector === notificationEntry) await shellReady
    },
  }

  const opened = openCollaborationNotifications(control)
  assert.deepEqual(calls, [['clickWhenEnabled', notificationEntry]])
  mountShell()
  await opened

  assert.deepEqual(calls, [
    ['clickWhenEnabled', notificationEntry],
    ['clickWhenEnabled', category],
  ])
})

test('missing notification entry remains a checkpoint failure', async () => {
  const calls = []
  const failure = new Error('Reloaded shell is unavailable')
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      throw failure
    },
  }

  await assert.rejects(openCollaborationNotifications(control), error => error === failure)
  assert.deepEqual(calls, [['clickWhenEnabled', '[data-testid="wework-notifications-button"]']])
})
