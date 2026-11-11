// @vitest-environment node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/workbench-apps.scenario.mjs'

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  readFile: vi.fn(),
}))

const installation = { id: 'todo-protocol', manifest: { flavor: 'lightweight' } }
const article = '[data-testid="smart-app-created-item-todo-protocol"]'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.mocked(readFile).mockReset()
})
afterEach(() => vi.useRealTimers())

// Protocol coverage only. The existing workbench-apps checkpoint uses real Host and DSH.
async function fixture({
  recordsOnAccept = [installation],
  cancelledResidue = false,
  snapshotError = null,
  workbenchReadyTimeoutMs = 30_000,
} = {}) {
  const events = []
  const accepted = Promise.withResolvers()
  const editorReached = new Error('Readiness verified; stop before editing the TODO')
  let records = []
  let attempts = 0
  let visible = false
  let sdkAvailable = false
  let finished = false
  vi.mocked(readFile).mockImplementation(async path => {
    assert.equal(path, join('/isolated-e2e/user-data', 'harness-apps', 'installations.json'))
    return JSON.stringify(records)
  })
  const scenario = await createDesktopScenario({
    workspacePath: '/isolated-e2e/workspace',
    electronUserDataDirectory: '/isolated-e2e/user-data',
    resultDir: '/isolated-e2e/results',
    uiTimeoutMs: 10_000,
    workbenchReadyTimeoutMs,
  })
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'navigate') return ''
      if (action === 'clickWhenEnabled') {
        assert.equal(selector, '[data-testid="workbench-create-todo"]')
        events.push(`create:${++attempts}`)
        assert.ok(attempts <= 2, 'Do not retry TODO creation')
        return ''
      }
      if (action === 'workbenchApp') {
        const request = JSON.parse(options.value)
        assert.equal(Object.hasOwn(options, 'timeoutMs'), false)
        if (request.action === 'installation') {
          if (!request.choice) return JSON.stringify({ visible: true, ready: true })
          events.push(request.choice)
          if (request.choice === 'cancel') records = cancelledResidue ? [installation] : []
          else {
            assert.equal(request.choice, 'accept')
            records = recordsOnAccept
            accepted.resolve()
          }
          return JSON.stringify({ clicked: true })
        }
        assert.equal(request.id, installation.id)
        if (request.action === 'snapshot') {
          events.push('snapshot')
          if (snapshotError) throw snapshotError
          return JSON.stringify({
            running: true,
            visible,
            sdkAvailable,
            presentation: 'window',
          })
        }
        assert.equal(request.action, 'getText')
        assert.equal(events.at(-1), 'card:identity')
        throw editorReached
      }
      if (action === 'waitFor') {
        if (selector.includes('smart-app-created-item-')) {
          assert.equal(selector, article, 'Card identity must come from the installed TODO')
          assert.equal(visible && sdkAvailable, true, 'Wait for the Host before the card')
          assert.equal(Object.hasOwn(options, 'timeoutMs'), false, 'Keep the 10-second UI default')
          events.push('card:ready')
        } else {
          assert.ok(
            [
              '[data-testid="smart-apps-owned-page"]',
              '[data-testid="workbench-create-todo"]:not([disabled])',
            ].includes(selector),
            selector
          )
        }
        return ''
      }
      assert.equal(action, 'getAttribute')
      assert.equal(selector, article)
      assert.equal(options.value, 'data-testid')
      events.push('card:identity')
      return `smart-app-created-item-${installation.id}`
    },
  }
  const result = scenario
    .verify(control)
    .then(
      () => null,
      error => error
    )
    .finally(() => {
      finished = true
    })
  return {
    accepted: accepted.promise,
    events,
    result,
    editorReached,
    get finished() {
      return finished
    },
    publish() {
      records = [installation]
    },
    show() {
      visible = true
    },
    initializeSdk() {
      sdkAvailable = true
    },
  }
}

test('waits through delayed installation and native startup before checking the exact card with the UI default', async () => {
  const app = await fixture({ recordsOnAccept: [] })
  await app.accepted
  await vi.advanceTimersByTimeAsync(10_500)
  assert.equal(app.finished, false)
  assert.equal(app.events.includes('snapshot'), false)
  app.publish()
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(app.events.includes('snapshot'), true)
  assert.equal(app.events.includes('card:ready'), false)
  app.show()
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(app.events.includes('card:ready'), false)
  app.initializeSdk()
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(await app.result, app.editorReached)
  assert.deepEqual(
    app.events.filter(event => event !== 'snapshot'),
    ['create:1', 'cancel', 'create:2', 'accept', 'card:ready', 'card:identity']
  )
  assert.equal(vi.getTimerCount(), 0)
})

test('shares the existing startup budget between installation discovery and Host readiness', async () => {
  const app = await fixture({ recordsOnAccept: [], workbenchReadyTimeoutMs: 1000 })
  await app.accepted
  await vi.advanceTimersByTimeAsync(700)
  app.publish()
  await vi.advanceTimersByTimeAsync(300)
  assert.match((await app.result).message, /TODO did not launch an independent DSH window/)
  assert.equal(app.events.includes('snapshot'), true)
  assert.equal(app.events.includes('card:ready'), false)
  assert.equal(vi.getTimerCount(), 0)
})

test('propagates a Host inspection error immediately without waiting for a card or retrying creation', async () => {
  const failure = new Error('Host inspection failed')
  const app = await fixture({ snapshotError: failure })
  assert.equal(await app.result, failure)
  assert.deepEqual(app.events, ['create:1', 'cancel', 'create:2', 'accept', 'snapshot'])
  assert.equal(vi.getTimerCount(), 0)
})

test('preserves the cancellation residue assertion before creating another TODO', async () => {
  const app = await fixture({ cancelledResidue: true })
  assert.match((await app.result).message, /Cancelling installation retained an application/)
  assert.deepEqual(app.events, ['create:1', 'cancel'])
  assert.equal(vi.getTimerCount(), 0)
})

test('rejects ambiguous TODO installation identities before querying native state', async () => {
  const app = await fixture({
    recordsOnAccept: [installation, { ...installation, id: 'todo-other' }],
  })
  assert.match((await app.result).message, /Created more than one TODO installation/)
  assert.equal(app.events.includes('snapshot'), false)
  assert.equal(app.events.includes('card:ready'), false)
})

test('preserves the lightweight registry assertion before querying native state', async () => {
  const app = await fixture({
    recordsOnAccept: [{ ...installation, manifest: { flavor: 'extended' } }],
  })
  const error = await app.result
  assert.ok(error instanceof assert.AssertionError)
  assert.equal(error.actual, 'extended')
  assert.equal(error.expected, 'lightweight')
  assert.equal(app.events.includes('snapshot'), false)
  assert.equal(app.events.includes('card:ready'), false)
})
