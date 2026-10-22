import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/reply-predictions.scenario.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createSingleRootLocalProject: async () => {},
  selectE2EModel: async () => {},
}))

test('waits for a real prediction request before editing the draft or checking its count', async () => {
  vi.useFakeTimers()
  try {
    const scenario = createDesktopScenario({ captureScreenshot: async () => {} })
    const commands = []
    const stop = new Error('Stop after releasing the held prediction')
    let showPending
    let initialInput
    const pendingVisible = new Promise(resolve => {
      showPending = resolve
    })
    const control = {
      async command(action, selector, options = {}) {
        commands.push({ action, selector, options })
        if (action === 'getElementCount') return '0'
        if (action === 'fill' && !initialInput) initialInput = options.value
        if (action === 'waitFor' && selector.includes('prediction-pending')) showPending()
        if (action === 'waitFor' && selector.endsWith('chat-message-input-prediction"]')) throw stop
        return ''
      },
    }
    const verification = scenario.verify(control).catch(error => error)
    await pendingVisible
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(
      commands.some(command => command.options.value === '生成时我也能输入'),
      false,
      'Draft editing began while the model server had not received the prediction'
    )
    const body = {
      model: 'gpt-5.6-luna',
      instructions: 'Fixture instructions',
      tools: [],
      input: initialInput,
    }
    const request = value =>
      Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { method: 'POST' })
    const response = { writeHead() {}, end() {} }
    const url = new URL('http://localhost/v1/responses')
    await scenario.handleHttp(request(body), response, url)
    const prediction = scenario.handleHttp(
      request({
        ...body,
        input: `${initialInput}\nPredict one natural next USER message`,
        reasoning: { effort: 'low' },
      }),
      response,
      url
    )

    assert.equal(await verification, stop)
    assert.equal(await prediction, true)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
