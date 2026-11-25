import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { testId, until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const SHARE_PATH = '/api/v1/assistant-shares'
const DATA = 'share-data'
const REVIEW = 'share-review'
const WEEKLY = 'share-weekly'
const RELEASE = 'share-release'
const ORIGINAL_PROMPT = 'SHARED_ORIGINAL_REPORT_PROCEDURE'
const UPDATED_PROMPT = 'SHARED_UPDATED_REPORT_PROCEDURE'
const LOCAL_PROMPT = '我的周报处理方式'
const PRIVATE_PREFERENCES = 'OWNER_PRIVATE_PREFERENCES_MUST_STAY_ON_DEVICE'
const DIRECT_MESSAGE = '请确认当前共享周报流程。'
const DIRECT_REPLY = '共享周报流程已确认。'
const FOLLOWUP_MESSAGE = '请重新确认更新后的周报流程。'
const FOLLOWUP_REPLY = '已采用新版周报流程。'
const DIALOG = testId('stand-in-shares-dialog')
const CHAT = testId('stand-in-conversation')

function assistant(id, name, prompt) {
  return { kind: 'assistant', definition: { id, name, prompt } }
}

function team(id, name, members) {
  return { kind: 'team', definition: { id, name, leadId: DATA, members } }
}

function requestBackend(cloud, token, path, { method = 'GET', body, status = 200 } = {}) {
  return fetch(cloud.backendUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  }).then(async response => {
    assert.equal(response.status, status, `${method} ${path}`)
    return response.json()
  })
}

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
}) {
  let cloud
  let recipient
  let publisher
  let publisherToken
  const data = assistant(DATA, '共享数据助理', ORIGINAL_PROMPT)
  const review = assistant(REVIEW, '共享审阅助理', '逐项检查指标')
  const weekly = team(WEEKLY, '共享周报团队', { [DATA]: '核对周报指标' })
  const release = team(RELEASE, '共享发布团队', { [DATA]: '核对发布指标' })
  const publisherRequest = (path, options) => requestBackend(cloud, publisherToken, path, options)
  const recipientRequest = (path, options) => requestBackend(cloud, cloud.authToken, path, options)
  const ref = (kind, id) => `${SHARE_PATH}/${publisher.id}/${kind}/${id}`

  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    backendEnv: {
      DB_INITIALIZATION_OWNER: 'rust',
      DB_AUTO_MIGRATE: 'true',
      ENVIRONMENT: 'development',
    },
    async prepareCloud(environment) {
      cloud = environment
      recipient = await recipientRequest('/api/users/me')
      const user_name = `share-story-${process.pid}`
      const password = `ShareStory-${process.pid}-fixture`
      publisher = await recipientRequest('/api/admin/users', {
        method: 'POST',
        body: { user_name, password, role: 'user', auth_source: 'password' },
        status: 201,
      })
      const session = await requestBackend(cloud, null, '/api/auth/login', {
        method: 'POST',
        body: { user_name, password },
      })
      publisherToken = session.access_token
      for (const root of [weekly, release]) {
        await publisherRequest(SHARE_PATH, {
          method: 'POST',
          body: { recipient_user_id: recipient.id, allow_copy: true, root, assistants: [data] },
        })
      }
    },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      const latest = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const currentMessage = JSON.stringify(latest ?? '')
      const isFirst = currentMessage.includes(DIRECT_MESSAGE)
      if (!isFirst && !currentMessage.includes(FOLLOWUP_MESSAGE)) return false
      if (isFirst) {
        assert.ok(JSON.stringify(body).includes(ORIGINAL_PROMPT), 'Direct use must load the team')
      } else {
        // Codex resumes with a content-addressed policy manifest when retained
        // history still carries the old developer instructions.
        const manifests = body.input.flatMap(item =>
          (Array.isArray(item.content) ? item.content : []).flatMap(part => [
            ...(part.text ?? '').matchAll(
              /read the complete policy skill at ("(?:[^"\\]|\\.)+") before proceeding/g
            ),
          ])
        )
        const manifest = manifests.at(-1)
        assert.ok(manifest, 'The continued conversation must receive the current policy manifest')
        const file = JSON.parse(manifest[1])
        const policyRoot = join(resultDir, 'executor-home', 'codex', 'runtime-policies')
        assert.match(relative(policyRoot, file).split(sep).join('/'), /^[0-9a-f]{64}\/SKILL\.md$/)
        const policy = await readFile(file, 'utf8')
        assert.ok(
          policy.includes(UPDATED_PROMPT),
          'The current policy must contain the updated assistant'
        )
        assert.ok(
          !policy.includes(ORIGINAL_PROMPT),
          'The current policy must replace the old prompt'
        )
        assert.ok(
          policy.includes('复核周报结论'),
          'The current policy must contain the new member duty'
        )
      }
      const id = isFirst ? 'shared-team-first-reply' : 'shared-team-followup-reply'
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(isFirst ? DIRECT_REPLY : FOLLOWUP_REPLY),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const { id: userId } = recipient
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const call = (operation, id, options = {}) =>
        control.command(operation, testId(id), { timeoutMs: uiTimeoutMs, ...options })
      const click = id => call('clickWhenEnabled', id)
      const wait = (id, options) => call('waitFor', id, options)
      const read = () => rpc('runtime.stand_in.personal.get', { userId })
      const save = settings => rpc('runtime.stand_in.personal.save', { userId, settings })
      const openShares = async () => {
        await click('stand-in-shares-open')
        await wait('stand-in-share-new', { enabled: true })
      }
      const closeShares = () => click('stand-in-shares-dialog-close')
      const send = async (message, reply) => {
        await control.command(
          'fill',
          `${CHAT} ${testId('chat-message-input')}[contenteditable="true"]`,
          {
            value: message,
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command('clickWhenEnabled', `${CHAT} ${testId('send-message-button')}`)
        await control.command('waitFor', `${CHAT} ${testId('assistant-message-content')}`, {
          text: reply,
          timeoutMs: modelResponseTimeoutMs,
        })
      }
      const inbox = () => recipientRequest('/api/v1/wework-notifications?category=general')
      await cloud.waitForConnectedAppDevice()
      const { deviceId } = await rpc('runtime.stand_in.device_identity', {})
      const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
      await rpc('runtime.stand_in.binding', {
        operation: 'bind',
        version: binding.version,
        target: { userId, deviceId, backendUrl: `${cloud.backendUrl}/api` },
      })
      await rpc('runtime.stand_in.onboarding.complete', {
        userId,
        weeklyReview: false,
        language: 'zh-CN',
      })
      const initial = await read()
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'Direct usage requires a configured recipient model')
      await save({
        ...initial,
        primary: {
          ...initial.primary,
          enabled: true,
          prompt: '',
          preferences: PRIVATE_PREFERENCES,
          model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
        },
      })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await openShares()
      assert.ok((await inbox()).items.some(item => item.kind === 'assistant_share'))
      await wait(`stand-in-share-copy-${WEEKLY}`, { enabled: true })
      await captureScreenshot(control, '01-direct-or-copy.png', DIALOG)
      await click(`stand-in-share-use-${WEEKLY}`)
      await wait('stand-in-role-help', { text: weekly.definition.name })
      await send(DIRECT_MESSAGE, DIRECT_REPLY)
      assert.ok(!(await read()).roles.some(role => role.name === data.definition.name))
      await captureScreenshot(control, '02-direct-conversation.png', testId('stand-in-overview'))
      await openShares()
      await click(`stand-in-share-copy-${WEEKLY}`)
      const firstCopy = await until(
        read,
        settings => settings.teams?.some(team => team.name === weekly.definition.name),
        'The copied weekly team must appear in local settings',
        uiTimeoutMs
      )
      const localData = firstCopy.roles.find(role => role.name === data.definition.name)
      assert.ok(localData)
      assert.equal(localData.prompt, ORIGINAL_PROMPT)
      assert.equal(localData.executionDeviceId, deviceId)
      assert.deepEqual(localData.connections ?? [], [])
      assert.equal(localData.collaboration.enabled, false)
      await save({
        ...firstCopy,
        roles: firstCopy.roles.map(role =>
          role.id === localData.id ? { ...role, prompt: LOCAL_PROMPT } : role
        ),
      })
      await until(
        () => recipientRequest(SHARE_PATH),
        result => result.received.some(row => row.derived && row.source_id === DATA),
        'The persisted copy receipt must register the shared member',
        40_000
      )
      await publisherRequest(`${SHARE_PATH}/owner-sync`, {
        method: 'PUT',
        body: { root: assistant(DATA, data.definition.name, UPDATED_PROMPT), expected_revision: 1 },
      })
      await click(`stand-in-share-copy-${RELEASE}`)
      const both = await until(
        read,
        settings => settings.teams?.some(team => team.name === release.definition.name),
        'The copied release team must appear in local settings',
        uiTimeoutMs
      )
      assert.deepEqual(
        both.roles
          .filter(role => role.name === data.definition.name)
          .map(role => [role.id, role.prompt]),
        [[localData.id, LOCAL_PROMPT]],
        'Copying another team must reuse and preserve the locally edited assistant'
      )
      assert.ok(both.teams.every(team => Object.hasOwn(team.members, localData.id)))
      await closeShares()
      await click('stand-in-teams-open')
      await wait('stand-in-teams-dialog', { text: weekly.definition.name })
      await wait('stand-in-teams-dialog', { text: release.definition.name })
      await captureScreenshot(control, '02a-copied-teams.png', testId('stand-in-teams-dialog'))
      for (const [index, copiedTeam] of both.teams.entries()) {
        await click(`stand-in-team-edit-${copiedTeam.id}`)
        const duty = await call('getValue', `stand-in-team-duty-${localData.id}`)
        assert.equal(duty, copiedTeam.members[localData.id])
        await captureScreenshot(
          control,
          `02a-${index + 1}-copied-team-members.png`,
          testId('stand-in-teams-dialog')
        )
        await click('stand-in-team-edit-cancel')
      }
      await click('stand-in-teams-dialog-close')

      const updatedWeekly = team(WEEKLY, weekly.definition.name, {
        [DATA]: '核对周报同比指标',
        [REVIEW]: '复核周报结论',
      })
      await publisherRequest(`${SHARE_PATH}/owner-sync`, {
        method: 'PUT',
        body: { root: updatedWeekly, assistants: [review], expected_revision: 1 },
      })
      const updates = (await inbox()).items.filter(item => item.kind === 'assistant_share_update')
      assert.deepEqual(updates.map(item => item.payload.sourceId).sort(), [DATA, WEEKLY].sort())
      await click('wework-notifications-button')
      await click('wework-notifications-category-general')
      for (const row of updates) await wait(`wework-notification-${row.id}`, { visible: true })
      await captureScreenshot(
        control,
        '02b-update-notifications.png',
        testId('wework-notifications-popover')
      )
      await click('wework-notifications-button')
      await openShares()
      await captureScreenshot(control, '02c-find-shared-conversation.png', DIALOG)
      await click(`stand-in-share-use-${WEEKLY}`)
      await control.command('waitFor', `${CHAT} ${testId('assistant-message-content')}`, {
        text: DIRECT_REPLY,
        timeoutMs: uiTimeoutMs,
      })
      await send(FOLLOWUP_MESSAGE, FOLLOWUP_REPLY)
      await captureScreenshot(
        control,
        '02d-continued-shared-conversation.png',
        testId('stand-in-overview')
      )
      await openShares()
      await wait(`stand-in-share-update-${DATA}`, { enabled: true })
      await click(`stand-in-share-update-${WEEKLY}`)
      await wait('stand-in-share-update-confirmation', { text: weekly.definition.name })
      await captureScreenshot(control, '03-apply-team-update.png')
      await click('stand-in-share-confirm-update')
      const updated = await until(
        read,
        settings => settings.roles.some(role => role.name === review.definition.name),
        'Updating the team must copy the new member',
        uiTimeoutMs
      )
      const weeklyCopy = updated.teams.find(team => team.name === weekly.definition.name)
      const reviewCopy = updated.roles.find(role => role.name === review.definition.name)
      assert.equal(weeklyCopy.members[localData.id], '核对周报同比指标')
      assert.equal(weeklyCopy.members[reviewCopy.id], '复核周报结论')
      assert.equal(updated.roles.find(role => role.id === localData.id).prompt, LOCAL_PROMPT)
      await click(`stand-in-share-update-${DATA}`)
      await wait('stand-in-share-update-confirmation', { text: data.definition.name })
      await captureScreenshot(control, '04-apply-assistant-update.png')
      await click('stand-in-share-confirm-update')
      await until(
        read,
        settings =>
          settings.roles.find(role => role.id === localData.id)?.prompt === UPDATED_PROMPT,
        'Applying the assistant update must replace the prompt in the existing copy',
        uiTimeoutMs
      )
      await closeShares()
      await click('stand-in-teams-open')
      await click(`stand-in-team-edit-${weeklyCopy.id}`)
      assert.equal(await call('getValue', `stand-in-team-duty-${reviewCopy.id}`), '复核周报结论')
      await captureScreenshot(
        control,
        '04a-updated-team-members.png',
        testId('stand-in-teams-dialog')
      )
      await click('stand-in-team-edit-cancel')
      await click('stand-in-teams-dialog-close')

      await publisherRequest(`${SHARE_PATH}/team/${WEEKLY}/recipients/${userId}`, {
        method: 'DELETE',
      })
      await recipientRequest(`${ref('team', WEEKLY)}/snapshot/direct`, { status: 404 })
      await assert.rejects(
        rpc('runtime.stand_in.conversation', {
          userId,
          message: '撤回后不应启动新一轮。',
          options: { conversationScope: `shared:${publisher.id}:team:${WEEKLY}` },
        }),
        /This assistant share is no longer available/
      )
      assert.ok((await read()).teams.some(team => team.id === weeklyCopy.id))
      await openShares()
      await wait('stand-in-shares-dialog', { text: weekly.definition.name })
      assert.equal(Number(await call('getElementCount', `stand-in-share-use-${WEEKLY}`)), 0)
      await click('stand-in-share-new')
      await call('fill', 'stand-in-share-recipient-search', { value: publisher.user_name })
      await click('stand-in-share-search')
      await click(`stand-in-share-recipient-${publisher.id}`)
      await captureScreenshot(control, '05-send-assistant-share.png', DIALOG)
      await click('stand-in-share-send')
      await wait(`stand-in-share-revoke-@primary-${publisher.id}`)
      const outgoing = await publisherRequest(`${SHARE_PATH}/${userId}/assistant/@primary`)
      assert.equal(outgoing.definition.kind, 'assistant')
      assert.deepEqual(Object.keys(outgoing.definition.definition).sort(), ['id', 'name', 'prompt'])
      assert.ok(!JSON.stringify(outgoing).includes(PRIVATE_PREFERENCES))
      const native = await read()
      await save({ ...native, primary: { ...native.primary, prompt: '新的主助理工作方式' } })
      await until(
        () => publisherRequest(`${SHARE_PATH}/${userId}/assistant/@primary`),
        share => share.definition.definition.prompt === '新的主助理工作方式',
        'Editing the source must publish its latest definition from the Executor',
        40_000
      )
    },
  }
}
