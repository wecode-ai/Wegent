// @vitest-environment node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, vi } from 'vitest'

import {
  openCollaborationNotifications,
  openProjectStandIn,
} from '../e2e/desktop/modules/stand-in-flows.mjs'

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
      if (action === 'getElementCount') return '1'
      if (action === 'clickWhenEnabled' && selector === entry) {
        await boardReady
        clicked = true
      }
      if (action === 'getValue') return 'default'
    },
  }

  const opened = openProjectStandIn(control, entry)
  assert.deepEqual(calls, [['click', '[data-testid="workspace-tab-select-fixed-board"]']])
  await vi.waitFor(() => assert.deepEqual(calls.at(-1), ['clickWhenEnabled', entry]))
  assert.equal(clicked, false)
  mountBoard()
  await opened

  assert.deepEqual(calls.slice(0, 4), [
    ['click', '[data-testid="workspace-tab-select-fixed-board"]'],
    ['getElementCount', entry],
    ['clickWhenEnabled', entry],
    ['waitFor', '[data-testid="stand-in-project-select"]'],
  ])
  assert.equal(clicked, true)
  assert.deepEqual(
    calls.filter(([action, selector]) => action === 'clickWhenEnabled' && selector === entry),
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
      if (action === 'click' && selector === '[data-testid="workspace-tab-select-fixed-board"]')
        return
      if (action === 'getElementCount') return '0'
      throw missingEntry
    },
  }

  await assert.rejects(openProjectStandIn(control, entry), error => error === missingEntry)
  assert.deepEqual(calls, [
    ['click', '[data-testid="workspace-tab-select-fixed-board"]'],
    ['getElementCount', entry],
    ['getElementCount', '[data-testid="personal-home-open-in-project"]'],
    ['clickWhenEnabled', entry],
  ])
})

test('personal home opens the selected Issue in its project before configuring the assistant', async () => {
  const calls = []
  const projectLink = '[data-testid="personal-home-open-in-project"]'
  const control = {
    async command(action, selector) {
      calls.push([action, selector])
      if (action === 'getElementCount') return selector === entry ? '0' : '1'
      if (action === 'getValue') return 'default'
    },
  }
  await openProjectStandIn(control, entry)
  assert.deepEqual(calls.slice(0, 5), [
    ['click', '[data-testid="workspace-tab-select-fixed-board"]'],
    ['getElementCount', entry],
    ['getElementCount', projectLink],
    ['clickWhenEnabled', projectLink],
    ['clickWhenEnabled', entry],
  ])
  assert.deepEqual(calls.at(-1), ['waitFor', '[data-testid="stand-in-prompt"]'])
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
