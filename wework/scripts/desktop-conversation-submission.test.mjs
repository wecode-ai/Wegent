import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { test, vi } from 'vitest'

import {
  sendPromptWithButton,
  verifyBackgroundGuidanceNavigation,
} from '../e2e/desktop/modules/conversation-navigation.mjs'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { createCheckpointTaskFixture } from '../e2e/desktop/modules/conversation-layout.mjs'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  triggerModelReloadUntilCloudFailure,
} from '../e2e/desktop/modules/shared.mjs'
import { sendOrderFollowUp } from '../e2e/desktop/modules/streaming-text-fixture.mjs'

test('retains a submission error without an unhandled model observer rejection', async () => {
  const sharedUrl = pathToFileURL(
    resolve(import.meta.dirname, '../e2e/desktop/modules/shared.mjs')
  ).href
  const source = `
    import assert from 'node:assert/strict'
    import { sendPromptUntilScenarioRequest } from ${JSON.stringify(sharedUrl)}
    const control = {
      awaitNextScenarioRequest: () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('model request timeout')), 20)
      }),
      async command(action) {
        if (action === 'getElementCount') return '0'
        if (action === 'fill') throw new Error('input unavailable')
        return ''
      },
    }
    await assert.rejects(
      sendPromptUntilScenarioRequest(control, 'body', 'prompt', 'fixture', 100),
      /input unavailable/
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    console.log('Request observer rejection handled')
  `
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--unhandled-rejections=strict',
    '--input-type=module',
    '-e',
    source,
  ])
  assert.match(stdout, /Request observer rejection handled/)
  assert.equal(stderr, '')
})

test('explicitly refreshes cloud models after the previously held request was cancelled', async () => {
  vi.useFakeTimers()
  try {
    const commands = []
    const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
      failedCloudModelRequests: 0,
      failedCloudModelWaiter: null,
      fatalErrorPromise: new Promise(() => {}),
      async command(action, selector, options = {}) {
        commands.push({ action, selector, options })
        if (action === 'clickWhenEnabled') {
          assert.equal(selector, '[data-testid="model-selector-button"]')
          this.failedCloudModelRequests += 1
          this.failedCloudModelWaiter?.()
          this.failedCloudModelWaiter = null
        }
        return ''
      },
    })
    const refreshed = triggerModelReloadUntilCloudFailure(control).then(
      () => null,
      error => error
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS * 2 + 1)
    assert.equal(await refreshed, null)
    assert.deepEqual(
      commands.map(command => command.action),
      ['clickWhenEnabled', 'press']
    )
    assert.equal(commands[0].options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
    assert.equal(commands[1].options.key, 'Escape')
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test('waits for the checkpoint model request before starting its unchanged UI budget', async () => {
  vi.useFakeTimers()
  try {
    const responseDelay = DEFAULT_STEP_TIMEOUT_MS + 250
    let submitted = false
    let received = false
    const taskRow = 'runtime-local-task-row-checkpoint'
    const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
      scenarioRequests: new Map(),
      scenarioWaiters: new Map(),
      fatalErrorPromise: new Promise(() => {}),
      setScenario: vi.fn(),
      async command(action, selector, options = {}) {
        if (action === 'snapshot') {
          return JSON.stringify({
            testIds: [`model-option-${DEFAULT_MODEL_ID}`, ...(received ? [taskRow] : [])],
            text: DEFAULT_MODEL_LABEL,
          })
        }
        if (action === 'getElementCount') return selector.includes('pause-response') ? '0' : '1'
        if (action === 'getAttribute')
          return options.value === 'aria-checked' ? 'true' : 'wework-e2e'
        if (action === 'getText') {
          return selector.includes(taskRow)
            ? 'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK'
            : DEFAULT_MODEL_LABEL
        }
        if (action === 'press' && options.key === 'Enter') {
          assert.equal(submitted, false, 'The checkpoint prompt was submitted more than once')
          submitted = true
          setTimeout(() => {
            received = true
            this.recordScenarioRequest('checkpoint_task', {})
          }, responseDelay)
        }
        if (action === 'waitFor' && selector.includes('message-assistant')) {
          assert.equal(received, true, 'Checkpoint UI waiting started before its model request')
          assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
          assert.equal(options.text, 'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK_COMPLETE')
        }
        return ''
      },
    })
    const created = createCheckpointTaskFixture(control, '[data-testid="chat-message-input"]').then(
      result => result,
      error => error
    )
    await vi.advanceTimersByTimeAsync(responseDelay)
    assert.equal(await created, taskRow)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

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
