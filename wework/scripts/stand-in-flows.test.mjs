import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'vitest'

import { openProjectStandIn } from '../e2e/desktop/modules/stand-in-flows.mjs'
import { openStandInNotifications } from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'

const entry = '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-open"]'

test.each(['cli', 'mcp'])(
  '%s capability scenario uses the startup budget only for cold catalog bootstrap',
  async boundary => {
    const source = await readFile(
      resolve(import.meta.dirname, `../e2e/desktop/scenarios/stand-in-${boundary}.scenario.mjs`),
      'utf8'
    )
    assert.match(
      source,
      /const catalog = await requestExecutor\(\s*control,\s*'runtime.connections.catalog',\s*\{\},\s*workbenchReadyTimeoutMs\s*\)/
    )
    assert.match(
      source,
      /const recovered = await requestExecutor\(\s*control,\s*'runtime.connections.catalog',\s*\{\},\s*uiTimeoutMs\s*\)/
    )
    assert.match(source, /fetchLocalRuntime\(control,/)
    assert.match(source, /timeoutMs: uiTimeoutMs/)
  }
)

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
      if (action === 'waitFor' && selector === notificationEntry) await shellReady
    },
  }

  const opened = openStandInNotifications(control)
  assert.deepEqual(calls, [['waitFor', notificationEntry]])
  mountShell()
  await opened

  assert.deepEqual(calls, [
    ['waitFor', notificationEntry],
    ['click', notificationEntry],
    ['waitFor', category],
    ['click', category],
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

  await assert.rejects(openStandInNotifications(control), error => error === failure)
  assert.deepEqual(calls, [['waitFor', '[data-testid="wework-notifications-button"]']])
})
