import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import {
  sendPromptWithButton,
  verifyBackgroundGuidanceNavigation,
} from '../e2e/desktop/modules/conversation-navigation.mjs'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'
import { sendOrderFollowUp } from '../e2e/desktop/scenarios/streaming-text.scenario.mjs'

test('starts the message-order UI budget after its model response has finished', async () => {
  vi.useFakeTimers()
  try {
    const responseDelay = DEFAULT_STEP_TIMEOUT_MS + 250
    const requests = Array.from({ length: 21 }, (_, index) => ({ followUpNumber: index + 1 }))
    const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
      scenarioRequests: new Map([['message_order_follow_up', requests]]),
      scenarioWaiters: new Map(),
      fatalErrorPromise: new Promise(() => {}),
      async command(action, _selector, options = {}) {
        if (action === 'clickWhenEnabled') {
          setTimeout(() => {
            this.recordScenarioRequest('message_order_follow_up', { followUpNumber: 22 })
          }, responseDelay)
        }
        if (action === 'waitFor') {
          assert.equal(requests.length, 22, 'UI waiting started before the model response')
          assert.equal(options.text, 'WEWORK_DESKTOP_E2E_ORDER_COMPLETION_22')
          assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
        }
        return ''
      },
    })

    const sent = sendOrderFollowUp(control, 22, DEFAULT_STEP_TIMEOUT_MS, 30_000).then(
      () => null,
      error => error
    )
    await vi.advanceTimersByTimeAsync(responseDelay)
    assert.equal(await sent, null)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test('rejects a model response recorded for a different message-order turn', async () => {
  const control = {
    command: vi.fn(async () => ''),
    awaitScenarioRequestCount: vi.fn(async () => ({ followUpNumber: 21 })),
  }
  await assert.rejects(sendOrderFollowUp(control, 22, 10_000, 30_000), /different follow-up turn/)
  assert.equal(control.command.mock.calls.length, 2)
})

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
