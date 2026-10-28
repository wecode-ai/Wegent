import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { observeCommentNavigation } from '../e2e/desktop/modules/comment-navigation.mjs'

afterEach(() => vi.useRealTimers())

function fixture(animationName = 'task-detail-comment-flash', flashTime = 200, options = {}) {
  let navigated = false
  let recorded
  const commands = []
  const sample = () => ({
    done: navigated,
    frames: navigated
      ? [
          {
            time: flashTime,
            connected: true,
            elements: [
              { animationName, width: options.hidden ? 0 : 100, height: 40, display: 'block' },
            ],
          },
          { time: 2500, connected: true, elements: [{ animationName: 'none' }] },
        ]
      : [
          {
            time: 0,
            connected: true,
            elements: options.previousFlash
              ? [{ animationName, width: 100, height: 40, display: 'block' }]
              : [],
          },
        ],
  })
  const control = {
    async command(action, selector, options) {
      commands.push({ action, selector, options })
      if (action === 'getElementMetricsSample' || action === 'stopElementMetricsSampling') {
        return JSON.stringify(sample())
      }
    },
  }
  return {
    commands,
    get recorded() {
      return recorded
    },
    get navigated() {
      return navigated
    },
    options: {
      control,
      selector: '[data-testid="active"] [data-testid="cloud-task-activity-message-42"]',
      navigate: async () => {
        assert.equal(commands[0].action, 'startElementMetricsSampling')
        navigated = true
      },
      waitForComment: async startedAt => {
        vi.setSystemTime(startedAt + 2500)
        return Date.now() - startedAt
      },
      timeoutMs: 10000,
      recordSample: async sample => {
        recorded = sample
      },
    },
  }
}

test('observes the exact target flash even when stable landing outlasts the live animation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const state = fixture()
  assert.deepEqual(await observeCommentNavigation(state.options), { commentMs: 2500, flashMs: 200 })
  assert.equal(state.commands[0].options.target, state.options.selector)
  assert.equal(state.commands[0].options.value, '10000')
  assert.equal(state.recorded.frames.at(-1).elements[0].animationName, 'none')
})

test.each(['none', 'unrelated-animation'])(
  'rejects missing or unrelated animation %s and retains failure evidence',
  async animationName => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const state = fixture(animationName)
    await assert.rejects(observeCommentNavigation(state.options), /never flashed/)
    assert.ok(state.recorded.done)
  }
)

test('retains late flash timestamps so the existing navigation budget still rejects them', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const state = fixture('task-detail-comment-flash', 8001)
  assert.equal((await observeCommentNavigation(state.options)).flashMs, 8001)
})

test('rejects a hidden target even when its computed animation name matches', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const state = fixture('task-detail-comment-flash', 200, { hidden: true })
  await assert.rejects(observeCommentNavigation(state.options), /never flashed/)
})

test('rejects a previous highlight before navigation can reuse it as evidence', async () => {
  const state = fixture('task-detail-comment-flash', 200, { previousFlash: true })
  await assert.rejects(observeCommentNavigation(state.options), /previous comment highlight/)
  assert.equal(state.navigated, false)
  assert.ok(state.recorded)
})

test('propagates a failed navigation and stops its sampler', async () => {
  const state = fixture()
  const failure = new Error('Notification click failed')
  state.options.navigate = async () => {
    throw failure
  }
  await assert.rejects(observeCommentNavigation(state.options), error => error === failure)
  assert.ok(state.recorded)
  assert.equal(state.commands.at(-1).action, 'stopElementMetricsSampling')
})
