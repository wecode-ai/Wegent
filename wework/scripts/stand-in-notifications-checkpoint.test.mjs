import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import {
  createDesktopScenario,
  prepareNotificationHitTesting,
} from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'
import { verifyNarrowImMenu } from '../e2e/desktop/modules/stand-in-im-menu-layout.mjs'
import { openCollaborationNotifications } from '../e2e/desktop/modules/stand-in-flows.mjs'

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
    'wework/e2e/desktop/modules/stand-in-im-menu-layout.mjs',
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
      if (action === 'clickWhenEnabled' && discoveryFailure)
        throw new Error('Real IM discovery failed')
      if (action === 'getElementCount') return String(count)
      if (action === 'getElementMetrics') {
        if (selector === 'body') return JSON.stringify([{ width: 760 }])
        const channel = selector.match(/stand-in-im-channel-([a-z]+)"/)[1]
        measured.push(channel)
        return JSON.stringify(channel === missingChannel ? [] : [{ width: 100, height }])
      }
      assert.ok(['waitFor', 'clickWhenEnabled'].includes(action), action)
    },
  }
}

test('measures exactly all four channel identities with one narrow resize and restore', async () => {
  const control = layoutControl()
  await verifyNarrowImMenu(control)
  assert.deepEqual(control.measured, ['dingtalk', 'telegram', 'discord', 'weibo'])
  assert.equal(control.calls.filter(call => call.action === 'setMainWindowSize').length, 2)
  assert.equal(control.calls.filter(call => call.action === 'clickWhenEnabled').length, 2)
  assert.equal(control.calls.at(-1).options.value, control.previous)
})

for (const [description, options, error] of [
  ['the observed 32px targets', { height: 32 }, /Narrow dingtalk menu target/],
  [
    'a missing channel identity',
    { missingChannel: 'discord' },
    /discord menu entry must be unique/,
  ],
  ['an incomplete initial fixture', { count: 3 }, /all four known IM channels/],
  ['an unexpected extra channel', { count: 5 }, /all four known IM channels/],
  ['failed discovery', { discoveryFailure: true }, /Real IM discovery failed/],
])
  test(`rejects ${description} and always restores the previous window`, async () => {
    const control = layoutControl(options)
    await assert.rejects(verifyNarrowImMenu(control), error)
    assert.equal(control.calls.at(-1).action, 'setMainWindowSize')
    assert.equal(control.calls.at(-1).options.value, control.previous)
  })

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const issue = `${content} [data-testid="cloud-todo-detail"]`
const popover = '[data-testid="wework-notifications-popover"]'
const notificationRow = '[data-testid="wework-notification-stand-in:original-task"]'

async function openPreparedInbox(control) {
  await prepareNotificationHitTesting(control, content, 'PRJ261E6109-1', notificationRow)
  await openCollaborationNotifications(control)
}

function restoredIssueControl({
  issuePresent = true,
  navigation = Promise.resolve(),
  exit = Promise.resolve(),
  closeError,
} = {}) {
  let issueMounted = issuePresent
  let issueVisible = issuePresent
  let inboxOpen = true
  let openingIssue
  let navigationObserved
  const navigating = new Promise(resolve => {
    navigationObserved = resolve
  })
  let removalStarted
  const removing = new Promise(resolve => {
    removalStarted = resolve
  })
  let inboxOpened
  const opened = new Promise(resolve => {
    inboxOpened = resolve
  })
  return {
    navigating,
    removing,
    opened,
    get inboxOpen() {
      return inboxOpen
    },
    async command(action, selector, options) {
      if (action === 'clickWhenEnabled' && selector === notificationRow) {
        assert.equal(inboxOpen, true)
        openingIssue = navigation.then(() => {
          issueMounted = true
          issueVisible = true
          inboxOpen = false
        })
      } else if (action === 'waitFor' && selector === issue) {
        if (options.visible === false) assert.equal(issueVisible, false)
        else {
          assert.equal(options.text, 'PRJ261E6109-1')
          if (!issueMounted)
            throw new Error(
              `Timed out waiting for selector "${issue}" containing "${options.text}"; matches=[]`
            )
        }
      } else if (
        action === 'clickWhenEnabled' &&
        selector.endsWith('[data-testid="cloud-todo-detail-close"]')
      ) {
        if (inboxOpen)
          throw new Error('The previous Issue closed before notification navigation completed')
        if (closeError) throw closeError
        issueVisible = false
      } else if (
        action === 'waitFor' &&
        selector === `${content}:not(:has([data-testid="cloud-todo-detail"]))`
      ) {
        assert.equal(issueVisible, false)
        removalStarted()
        await exit
        issueMounted = false
      } else if (
        action === 'clickWhenEnabled' &&
        selector === '[data-testid="wework-notifications-button"]'
      ) {
        // Programmatic clicks can open an inbox still covered by the modal layer.
        inboxOpen = true
        inboxOpened()
      } else if (
        action === 'clickWhenEnabled' &&
        selector === '[data-testid="wework-notifications-category-collaboration"]'
      ) {
        assert.equal(inboxOpen, true)
      } else if (action === 'clickAt') {
        assert.deepEqual(JSON.parse(options.value), { x: 927, y: 128 })
        if (!issueMounted) inboxOpen = false
        // Both the covered Issue and the notification have this title in CI.
        return '在通知内继续处理助理任务'
      } else if (action === 'waitFor' && selector === popover) {
        assert.equal(options.visible, false)
        navigationObserved()
        await openingIssue
        if (inboxOpen) throw new Error(`Timed out waiting for selector "${popover}"; visible=true`)
      } else throw new Error(`Unexpected ${action} for ${selector}`)
    },
  }
}

for (const issuePresent of [false, true])
  test(`notification icon dismisses the inbox when reload leaves the Issue ${issuePresent ? 'restored' : 'absent'}`, async () => {
    const control = restoredIssueControl({ issuePresent })
    await openPreparedInbox(control)
    await control.command('clickAt', 'body', { value: JSON.stringify({ x: 927, y: 128 }) })
    await control.command('waitFor', popover, { visible: false })
  })

test(
  'an existing Issue cannot satisfy readiness before the selected notification dismisses its inbox',
  { timeout: 1000 },
  async () => {
    let finishNavigation
    const navigation = new Promise(resolve => {
      finishNavigation = resolve
    })
    const control = restoredIssueControl({ navigation })
    const reopening = openPreparedInbox(control)
    try {
      await Promise.race([control.navigating, reopening])
      assert.equal(
        control.inboxOpen,
        true,
        'The current row action must complete before Issue closing'
      )
    } finally {
      finishNavigation()
    }
    await reopening
    await control.command('clickAt', 'body', { value: JSON.stringify({ x: 927, y: 128 }) })
    await control.command('waitFor', popover, { visible: false })
  }
)

test(
  'reload recovery waits for full Issue removal after its exit frame becomes invisible',
  { timeout: 1000 },
  async () => {
    let finishExit
    const exit = new Promise(resolve => {
      finishExit = resolve
    })
    const control = restoredIssueControl({ exit })
    const reopening = openPreparedInbox(control)
    try {
      await Promise.race([control.removing, reopening])
      await Promise.race([
        control.opened.then(() => {
          throw new Error('The inbox opened while Issue removal was pending')
        }),
        new Promise(resolve => setTimeout(resolve, 50)),
      ])
      assert.equal(
        control.inboxOpen,
        false,
        'The modal must release its layer before reopening the inbox'
      )
    } finally {
      finishExit()
    }
    await reopening
    assert.equal(control.inboxOpen, true)
  }
)

test('reload recovery propagates failed Issue closing without opening an obscured inbox', async () => {
  const control = restoredIssueControl({ closeError: new Error('Issue close failed') })
  await assert.rejects(openPreparedInbox(control), /Issue close failed/)
  assert.equal(control.inboxOpen, false)
})
