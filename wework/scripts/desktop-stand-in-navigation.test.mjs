import assert from 'node:assert/strict'
import { test } from 'vitest'
import { openProjectStandIn } from '../e2e/desktop/modules/stand-in-flows.mjs'

const ENTRY = '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-open"]'

test('waits for the project entry to remount after closing personal stand-in settings', async () => {
  const calls = []
  let entryMounted = false
  let mountEntry
  const mounted = new Promise(resolve => {
    mountEntry = () => {
      entryMounted = true
      resolve()
    }
  })
  const control = {
    async command(action, selector) {
      calls.push({ action, selector })
      if (selector === ENTRY) {
        if (action === 'clickWhenEnabled') await mounted
        assert.ok(entryMounted, 'The project is still loading after personal settings closed')
      }
      if (action === 'getValue') return 'default'
      return ''
    },
  }

  const opening = openProjectStandIn(control, ENTRY).then(
    () => null,
    error => error
  )
  await Promise.resolve()
  assert.deepEqual(calls, [{ action: 'clickWhenEnabled', selector: ENTRY }])
  mountEntry()
  assert.equal(await opening, null)

  assert.ok(
    calls.some(
      ({ action, selector }) =>
        action === 'click' && selector === '[data-testid="stand-in-personal-settings-link"]'
    )
  )
})

test('propagates a missing project entry without attempting to open personal settings', async () => {
  const calls = []
  const failure = new Error('Project stand-in entry did not become available')
  const control = {
    async command(action, selector) {
      calls.push({ action, selector })
      throw failure
    },
  }

  await assert.rejects(openProjectStandIn(control, ENTRY), error => error === failure)
  assert.deepEqual(calls, [{ action: 'clickWhenEnabled', selector: ENTRY }])
})
