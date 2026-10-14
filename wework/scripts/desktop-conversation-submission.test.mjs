import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import {
  sendPromptWithButton,
  verifyBackgroundGuidanceNavigation,
} from '../e2e/desktop/modules/conversation-navigation.mjs'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

test('submits once after a restored conversation finishes loading its model catalog', async () => {
  const prompt = 'Continue the persisted conversation after restart'
  let catalogReady = false
  let composerValue = ''
  let submissions = 0
  let keyPresses = 0
  const catalogLoaded = new Promise(resolve => {
    setTimeout(() => {
      catalogReady = true
      resolve()
    }, 50)
  })
  const control = {
    async command(action, selector, options = {}) {
      switch (action) {
        case 'getElementCount':
          return '0'
        case 'fill':
          composerValue = options.value
          return ''
        case 'waitFor':
          if (options.enabled) {
            assert.ok(selector.includes('send-message-button'))
            await catalogLoaded
          } else {
            assert.equal(composerValue, options.text)
          }
          return ''
        case 'press':
          keyPresses += 1
          if (catalogReady) {
            submissions += 1
            composerValue = ''
          }
          return ''
        case 'snapshot':
          return JSON.stringify({ testIds: [], text: submissions ? prompt : '' })
        case 'getValue':
          return composerValue
        default:
          throw new Error(`Unexpected control action ${action}`)
      }
    },
  }

  await sendPromptWithButton(control, '[data-testid="chat-input"]', prompt, 500)

  assert.equal(submissions, 1)
  assert.equal(keyPresses, 1)
  assert.equal(composerValue, '')
})

test('a missing model request stops polling when its budget expires', async () => {
  vi.useFakeTimers()
  try {
    const readRequests = vi.fn(() => undefined)
    const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
      scenarioRequests: { get: readRequests },
      fatalErrorPromise: new Promise(() => {}),
    })
    const failed = assert.rejects(
      control.awaitScenarioRequestCount('model_proxy_restart', 2, 20),
      /Timed out waiting for 2 model_proxy_restart scenario requests/
    )
    await vi.advanceTimersByTimeAsync(20)
    await failed
    const readsAtTimeout = readRequests.mock.calls.length

    await vi.advanceTimersByTimeAsync(200)

    assert.equal(readRequests.mock.calls.length, readsAtTimeout)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test('returns an already observed request without starting a timer', async () => {
  const request = { id: 'follow-up' }
  const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
    scenarioRequests: new Map([['model_proxy_restart', [request]]]),
    fatalErrorPromise: new Promise(() => {}),
  })

  assert.equal(await control.awaitScenarioRequestCount('model_proxy_restart', 1, 0), request)
})

test('a controller failure still rejects an already observed model request', async () => {
  const failure = new Error('Model protocol failure')
  const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
    scenarioRequests: new Map([['model_proxy_restart', [{ id: 'follow-up' }]]]),
    fatalError: failure,
  })

  await assert.rejects(control.awaitScenarioRequestCount('model_proxy_restart', 1), failure)
})

test('background guidance waits for real tool output using the model-stage budget', async () => {
  vi.useFakeTimers()
  try {
    const toolOutputAt = Date.now() + DEFAULT_STEP_TIMEOUT_MS + 250
    const nextUiAction = new Error('Tool output observed; reached guidance input')
    const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
      scenarioRequests: { get: () => (Date.now() >= toolOutputAt ? [{}, {}] : [{}]) },
      fatalErrorPromise: new Promise(() => {}),
      modelStage: 'awaiting_guidance',
      holdInitialCompletionResponse() {},
      releaseInitialToolExecution() {},
      async command(action) {
        if (action === 'getElementCount') return '1'
        assert.equal(action, 'fill')
        throw nextUiAction
      },
    })
    const result = verifyBackgroundGuidanceNavigation({
      control,
      composerSelector: '[data-testid="chat-input"]',
    }).catch(error => error)

    await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 1000)

    assert.equal(await result, nextUiAction)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
