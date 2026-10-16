import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_COMPOSER_SELECTOR, ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'
import { testId } from './plugin-regression-fixture.mjs'
import { assistantMessage, latestModelInputText } from './response-protocol.mjs'

const CONTINUATIONS = [
  '插件授权已完成。请从刚才因授权中断的位置继续任务，不要重复已经完成的操作。',
  'Plugin authorization is complete. Continue the task from the step blocked by authorization without repeating completed actions.',
]

export function createConversationAuthModelFixture({ slug, qrPrompt, ghResumePrompt }) {
  const cases = new Map()
  let githubRequests = 0
  return {
    cases,
    getGithubRequests: () => githubRequests,
    begin(name, connectorSlug = 'conversation-qr') {
      assert.ok(!cases.has(name), `Duplicate conversation auth case: ${name}`)
      let release
      const responseReady = new Promise(resolve => {
        release = resolve
      })
      const state = {
        prompt: `${qrPrompt} ${name}`,
        connectorSlug,
        requests: 0,
        continuations: [],
        responseReady,
        release,
      }
      cases.set(name, state)
      return state
    },
    async respond(body) {
      const latest = latestModelInputText(body)
      if (latest.includes(ghResumePrompt)) {
        githubRequests += 1
        return [
          assistantMessage(
            'connector_auth_required\n\n- `pluginKey`: `github`\n- `connectorSlug`: `wework-github-cli`\n\nGitHub CLI login is required.'
          ),
        ]
      }
      const continuation = CONTINUATIONS.find(text => latest.includes(text))
      const requestText = JSON.stringify(body)
      const state = [...cases.values()]
        .reverse()
        .find(item => (continuation ? requestText : latest).includes(item.prompt))
      if (!state) return null
      if (continuation) {
        state.continuations.push(continuation)
        return [assistantMessage(`${state.prompt} completed`)]
      }
      state.requests += 1
      await state.responseReady
      return [
        assistantMessage(
          `connector_auth_required\npluginKey=${slug}\nconnectorSlug=${state.connectorSlug}`
        ),
      ]
    },
  }
}

export async function verifyConversationQrAuthorization({
  control,
  slug,
  ordinaryPrompt,
  authModel,
  getOrdinaryRequests,
  qrApproval,
  captureScreenshot,
  homePath,
  pluginRoots,
  waitForValue,
}) {
  const eventsPath = join(homePath, 'conversation-qr-events.jsonl')
  const readEvents = async () =>
    (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  const logout = () =>
    control.command('localConnectorAuth', 'body', {
      value: JSON.stringify({
        pluginKey: slug,
        connectorSlug: 'conversation-qr',
        action: 'logout',
      }),
    })
  const assertNoCard = async message => {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(!snapshot.testIds.includes('connector-auth-card'), message)
  }
  const assertNoContinuation = () => {
    for (const state of authModel.cases.values()) {
      assert.equal(state.requests, 1, 'Authorization replayed an original plugin prompt')
      assert.equal(
        state.continuations.length,
        state.completed ? 1 : 0,
        `An obsolete authorization continued ${state.prompt}`
      )
    }
  }
  const sendOrdinary = async () => {
    const before = getOrdinaryRequests()
    const newMessageSelector = await newConversationMessageSelector(control)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ordinaryPrompt })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', newMessageSelector, {
      text: `${ordinaryPrompt} completed`,
    })
    await control.command('waitFor', 'body', {
      text: `${ordinaryPrompt} completed`,
      // Observe beyond the real provider's one-second polling interval.
      stableMs: 1500,
    })
    assert.equal(getOrdinaryRequests(), before + 1, 'Ordinary chat was blocked or sent twice')
    assertNoContinuation()
    await assertNoCard('Stale authorization blocked ordinary chat')
  }
  const beginOnUse = async (name, connectorSlug) => {
    await logout()
    const state = authModel.begin(name, connectorSlug)
    await control.command('click', testId('new-chat-button'))
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: state.prompt })
    const beforeSelection = await readEvents()
    await control.command('click', testId('composer-plugin-picker-button'))
    await control.command('fill', testId('composer-plugin-picker-search'), { value: slug })
    await control.command('click', testId('composer-plugin-picker-item-plugin:' + slug))
    await control.command('waitFor', testId('composer-plugin-chip-' + slug))
    await assertNoCard('Selecting a plugin opened authorization before a tool required it')
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await waitForValue(
      () => state.requests,
      count => count === 1,
      10_000,
      'The first plugin message waited for authorization before reaching the model'
    )
    assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), '')
    await assertNoCard('Plugin message was checked before the model returned an auth error')
    assert.deepEqual(await readEvents(), beforeSelection, 'Plugin selection or send probed auth')
    return state
  }
  const approve = async state => {
    await writeFile(qrApproval, 'approved')
    await control.command('waitFor', 'body', { text: `${state.prompt} completed` })
    state.completed = true
    assert.equal(state.requests, 1, 'Authorization resent the original plugin message')
    assert.equal(state.continuations.length, 1, 'Authorization did not continue exactly once')
    assert.ok(CONTINUATIONS.includes(state.continuations[0]), 'Unexpected continuation prompt')
    await assertNoCard('QR card remained after authorization')
  }

  const failurePath = join(homePath, 'conversation-qr-fail')
  const healthFailure = join(homePath, 'conversation-qr-health-fail')
  const manifests = []
  for (const root of new Set(pluginRoots)) {
    const path = join(root, '.codex-plugin/plugin.json')
    manifests.push({ path, original: await readFile(path, 'utf8') })
  }
  try {
    // Use the real installed package, manifest reader, packaged auth CLI and QR
    // session. Only the model response is held until the first send is verified.
    for (const action of ['cancel', 'ordinary', 'switch', 'resume']) {
      const state = await beginOnUse(action)
      state.release()
      await control.command('waitFor', testId('connector-auth-qr'))
      assert.equal(state.requests, 1)
      assert.equal(state.continuations.length, 0)
      await captureScreenshot(control, `plugin-auth-conversation-${action}-qr.png`, 'body')
      if (action === 'resume') {
        const unsentDraft = 'Unsent follow-up while plugin authorization is pending'
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: unsentDraft })
        await approve(state)
        assert.equal(
          await control.command('getValue', ACTIVE_COMPOSER_SELECTOR),
          unsentDraft,
          'Authorization continuation discarded an unsent composer draft'
        )
        continue
      }
      if (action === 'cancel') {
        await control.command('click', testId('connector-auth-cancel'))
        assert.equal(
          await control.command('getValue', ACTIVE_COMPOSER_SELECTOR),
          '',
          'Cancelling authorization restored a message that was already sent'
        )
        await writeFile(qrApproval, 'approved')
      }
      if (action === 'switch') {
        await control.command('click', testId('new-chat-button'))
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
        await writeFile(qrApproval, 'approved')
      }
      await sendOrdinary()
      if (action === 'ordinary') {
        // Late approval of the replaced authorization must not resume old work.
        await writeFile(qrApproval, 'approved')
        await sendOrdinary()
      }
    }
    // Failure comes from the actual packaged provider, never from mocked IPC.
    await writeFile(failurePath, 'fail')
    const failedStart = await beginOnUse('start-failure')
    failedStart.release()
    await control.command('waitFor', testId('connector-auth-error'), {
      text: 'E2E_QR_START_FAILED',
    })
    assert.equal(failedStart.requests, 1)
    assert.equal(failedStart.continuations.length, 0)
    await rm(failurePath)
    await control.command('clickWhenEnabled', testId('connector-auth-retry'))
    await control.command('waitFor', testId('connector-auth-qr'))
    await control.command('click', testId('connector-auth-cancel'))
    await sendOrdinary()

    await writeFile(healthFailure, 'fail')
    const failedHealth = await beginOnUse('health-failure')
    failedHealth.release()
    await control.command('waitFor', testId('chat-input-error'), {
      text: '无法确认插件登录状态',
    })
    assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), '')
    await assertNoCard('Health errors were treated as logout')
    assertNoContinuation()
    await rm(healthFailure)
    await sendOrdinary()
    await captureScreenshot(control, 'plugin-auth-failure-navigation-recovery.png', 'body')

    // Upgrade the isolated package after selection. The runtime error names
    // the new connector, so real health/start must resolve its current metadata.
    const replacement = await beginOnUse('metadata-replacement', 'conversation-qr-local')
    for (const { path, original } of manifests) {
      const manifest = JSON.parse(original)
      const connector = manifest.connectors.find(item => item.slug === 'conversation-qr')
      assert.ok(connector, 'Expected the original local connector')
      manifest.version = '2.0.0'
      connector.slug = 'conversation-qr-local'
      connector.displayName = 'Conversation QR upgraded'
      for (const action of ['health', 'start', 'poll', 'logout']) {
        connector.localAuth[action].push('replacement-v2')
      }
      await writeFile(path, JSON.stringify(manifest))
    }
    replacement.release()
    await control.command('waitFor', testId('connector-auth-qr'))
    const replacementEvents = await readEvents()
    for (const action of ['health', 'start']) {
      assert.ok(
        replacementEvents.some(
          event => event.action === action && event.revision === 'replacement-v2'
        ),
        `Authorization used stale ${action} metadata after the package upgrade`
      )
    }
    await approve(replacement)
    assertNoContinuation()
    await captureScreenshot(control, 'plugin-auth-replaced-connector-connected.png', 'body')
  } finally {
    for (const state of authModel.cases.values()) state.release()
    for (const { path, original } of manifests) await writeFile(path, original)
    await rm(failurePath, { force: true })
    await rm(healthFailure, { force: true })
    await logout()
  }
}

async function newConversationMessageSelector(control) {
  const selector =
    '[data-workspace-tab-content][aria-hidden="false"] ' +
    `${ACTIVE_WORKBENCH_SELECTOR}[data-active-workbench-pane="true"] ` +
    '[data-testid="message-assistant"][data-message-id]'
  const { location } = JSON.parse(await control.command('snapshot', 'body'))
  const { searchParams } = new URL(location)
  const deviceId = searchParams.get('deviceId')
  const taskId = searchParams.get('taskId')
  if (!deviceId || !taskId) return selector
  const messages = JSON.parse(
    await control.command('getRuntimeConversationMessages', 'body', {
      value: JSON.stringify({ deviceId, taskId }),
    })
  )
  // Prior turns can contain the same completion text as the next request.
  return messages.reduce(
    (current, message) => `${current}:not([data-message-id=${JSON.stringify(message.id)}])`,
    selector
  )
}
