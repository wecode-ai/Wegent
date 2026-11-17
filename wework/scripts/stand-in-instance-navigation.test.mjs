// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { stopBoundStandIn } from '../e2e/desktop/modules/stand-in-instance-flows.mjs'

const fixtures = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: fixtures.request }))

afterEach(() => vi.clearAllMocks())

function boundInstance({ primaryOpen = false, confirmStops = true } = {}) {
  const target = { userId: 7, deviceId: 'remote-executor', backendUrl: 'https://cloud.test' }
  let binding = { status: 'active', version: 3, target }
  const transitions = []
  fixtures.request.mockImplementation(async (_control, method, params) => {
    assert.equal(method, 'runtime.stand_in.binding')
    assert.deepEqual(params, { operation: 'get' })
    return binding
  })
  return {
    transitions,
    control: {
      async command(action, selector, options = {}) {
        if (action === 'getElementCount') {
          if (selector.includes('stand-in-instance-stop')) return primaryOpen ? '1' : '0'
          if (selector.includes('stand-in-close')) return '0'
        }
        if (action === 'navigate') {
          assert.equal(options.value, '/stand-in?profileId=@primary')
          assert.equal(binding.target, target, 'Opening settings must retain the bound Executor')
          primaryOpen = true
          transitions.push('open-bound-primary')
          return ''
        }
        if (action === 'clickWhenEnabled' && selector.includes('stand-in-primary-open'))
          assert.fail('Onboarding makes the embedded home primary trigger inert')
        if (action === 'clickWhenEnabled' && selector.includes('stand-in-instance-stop-confirm')) {
          assert.equal(primaryOpen, true)
          transitions.push('confirm-stop')
          if (confirmStops) binding = { ...binding, status: 'stopped', version: 4 }
          return ''
        }
        if (action === 'clickWhenEnabled' && selector.includes('stand-in-instance-stop')) {
          assert.equal(primaryOpen, true)
          assert.equal(binding.target, target)
          transitions.push('request-stop')
          return ''
        }
        if (action === 'waitFor') {
          if (selector.includes('stand-in-instance-stopped')) transitions.push('observe-stopped')
          else assert.equal(primaryOpen, true)
          return ''
        }
        throw new Error(`Unexpected control command: ${action} ${selector}`)
      },
    },
  }
}

test('opens the bound primary settings before stopping through an unfinished home onboarding', async () => {
  const fixture = boundInstance()
  await stopBoundStandIn(fixture.control, 1000)
  assert.deepEqual(fixture.transitions, [
    'open-bound-primary',
    'request-stop',
    'confirm-stop',
    'observe-stopped',
  ])
  assert.equal(fixtures.request.mock.calls.length, 1)
})

test('stops an already open bound profile without navigating or completing onboarding', async () => {
  const fixture = boundInstance({ primaryOpen: true })
  await stopBoundStandIn(fixture.control, 1000)
  assert.deepEqual(fixture.transitions, ['request-stop', 'confirm-stop', 'observe-stopped'])
})

test('requires the authoritative binding to report stopped after the UI confirmation', async () => {
  const fixture = boundInstance({ primaryOpen: true, confirmStops: false })
  await assert.rejects(stopBoundStandIn(fixture.control, 1000), /active.*stopped/s)
})
