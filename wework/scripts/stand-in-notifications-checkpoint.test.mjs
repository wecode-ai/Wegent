import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'
import { verifyNarrowImChannels } from '../e2e/desktop/modules/stand-in-im-channel-layout.mjs'

test('stand-in IM native keyboard runs in the foreground without competing for native focus', () => {
  const scenario = createDesktopScenario({})
  const environment = { WEWORK_E2E_BACKGROUND_WINDOW: '1', ...scenario.appEnvironment }
  assert.equal(environment.WEWORK_E2E_BACKGROUND_WINDOW, '0')
  assert.deepEqual(
    loadDesktopCheckpointCatalog().CHECKPOINT_RESOURCES.get('stand-in-notifications'),
    ['macos-inspector-foreground']
  )
})

test('narrow IM coverage retains the existing real-Backend checkpoint and CI paths', () => {
  assert.equal(createDesktopScenario({}).requiresCloudEnvironment, true)
  const catalog = loadDesktopCheckpointCatalog()
  assert.ok(catalog.ci.core_segments.includes('stand-in-notifications'))
  for (const path of [
    'wework/e2e/desktop/modules/stand-in-im-connections.mjs',
    'wework/e2e/desktop/modules/stand-in-im-channel-layout.mjs',
  ])
    assert.deepEqual(catalog.PATH_TARGETS.get(path), ['core:stand-in-notifications'])
})

function layoutControl({ height = 44, missingChannel, count = 4, discoveryFailure = false } = {}) {
  const calls = []
  const measured = []
  const previous = JSON.stringify({ width: 1280, height: 720, maximized: true })
  let resized = false
  return {
    calls,
    measured,
    previous,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'setMainWindowSize') {
        if (!resized) {
          resized = true
          assert.deepEqual(JSON.parse(options.value), { width: 760, height: 760 })
          return previous
        }
        assert.equal(options.value, previous)
        return previous
      }
      if (action === 'waitFor' && discoveryFailure)
        throw new Error('Real IM discovery failed')
      if (action === 'getElementCount') return String(count)
      if (action === 'getElementMetrics') {
        if (selector === 'body') return JSON.stringify([{ width: 760 }])
        const channel = selector.match(/stand-in-im-channel-([a-z]+)"/)[1]
        measured.push(channel)
        return JSON.stringify(channel === missingChannel ? [] : [{ width: 100, height }])
      }
      assert.equal(action, 'waitFor')
    },
  }
}

test('measures exactly all four channel identities with one narrow resize and restore', async () => {
  const control = layoutControl()
  await verifyNarrowImChannels(control)
  assert.deepEqual(control.measured, ['dingtalk', 'telegram', 'discord', 'weibo'])
  assert.equal(control.calls.filter(call => call.action === 'setMainWindowSize').length, 2)
  assert.equal(control.calls.filter(call => call.action === 'clickWhenEnabled').length, 0)
  assert.equal(control.calls.at(-1).options.value, control.previous)
})

for (const [description, options, error] of [
  ['the observed 32px targets', { height: 32 }, /Narrow dingtalk channel target/],
  [
    'a missing channel identity',
    { missingChannel: 'discord' },
    /discord entry must be unique/,
  ],
  ['an incomplete initial fixture', { count: 3 }, /all four known IM channels/],
  ['an unexpected extra channel', { count: 5 }, /all four known IM channels/],
  ['failed discovery', { discoveryFailure: true }, /Real IM discovery failed/],
])
  test(`rejects ${description} and always restores the previous window`, async () => {
    const control = layoutControl(options)
    await assert.rejects(verifyNarrowImChannels(control), error)
    assert.equal(control.calls.at(-1).action, 'setMainWindowSize')
    assert.equal(control.calls.at(-1).options.value, control.previous)
  })
