import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { createMeetingUserStory } from '../modules/stand-in-meeting-user-story.mjs'
import { STORY_CHAT, STORY_USER, storyUntil } from '../modules/stand-in-source-story-evidence.mjs'

const { examples, create_prompt: addPrompt } = JSON.parse(
  readFileSync(new URL('../../../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
).standIn.welcome
const providerId = '@wegent/dsh-connection-dingtalk/dingtalk'
const byId = id => `[data-testid="${id}"]`
const home = byId('stand-in-welcome')
const proposal = byId('stand-in-proposal')
const input = `${STORY_CHAT} ${byId('chat-message-input')}`
const send = `${STORY_CHAT} ${byId('send-message-button')}`
const roleId = 'welcome-launch-assistant'
const addedRole = { id: 'welcome-release-notes', name: '发布说明校对助理' }
const addRequest = addPrompt + '请叫它「发布说明校对助理」，只校对我在对话中发给它的发布说明。'
const launchResponsibilities =
  '发现发布窗口变更、回归阻塞或有人等待确认时，汇报发生了什么、谁在等及消息原文。按已确认的发布和验收口径起草回复，由用户确认后再发。涉及改发布时间或对客户承诺，说明影响并等待用户决定。'
const followUp = '上线组有一项支付回调回归未通过，17:30 复测后需要确认发布窗口。'
const sourceMessage =
  '回归结果：支付回调还有一条用例未通过，等 17:30 复测。客户成功同事在等是否能承诺今晚发布。'

function dingTalkMessages(messages) {
  return JSON.stringify({
    success: true,
    result: {
      hasMore: false,
      nextCursor: '0',
      conversationMessagesList: [
        { openConversationId: 'scoped-group', singleChat: false, messages },
      ],
    },
  })
}

async function chooseExample(control, id) {
  await control.command('clickWhenEnabled', byId(`stand-in-welcome-example-${id}`))
  await control.command('clickWhenEnabled', byId('stand-in-welcome-start'))
  await control.command('waitFor', input, { text: examples[id].prompt.split('\n')[0] })
}

export function createDesktopScenario(options) {
  const { captureScreenshot, uiTimeoutMs, modelResponseTimeoutMs, workbenchReadyTimeoutMs } =
    options
  const fixture = createStandInDingTalkFixture(options)
  const messagesPath = join(options.resultDir, 'welcome-dingtalk-messages.json')
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const load = control => rpc(control, 'runtime.stand_in.personal.get', { userId: STORY_USER })
  const meetingRequest = examples.meeting_prep.prompt + '\n\n材料见会话《发布评审会原始材料》。'
  const meeting = createMeetingUserStory({
    ...options,
    rpc,
    request: meetingRequest,
    async openRequest(control) {
      await control.command('clickWhenEnabled', byId('stand-in-welcome-open'))
      await control.command('waitFor', home)
      await captureScreenshot(control, '05-assistant-home-return.png')
      await chooseExample(control, 'meeting_prep')
      await captureScreenshot(control, '06-meeting-draft.png')
      await control.command('fill', input, { value: meetingRequest })
    },
  })
  let activeStory
  const personalRole = (current, identity) => ({
    ...identity,
    enabled: true,
    executionDeviceId: current.executionDeviceId,
    model: current.primary.model,
    version: 0,
    collaboration: {
      enabled: false,
      allProjects: false,
      projects: [],
      excludedProjects: [],
      tags: [],
    },
  })
  const has = requestContainsToolOutput
  const read = (body, id) => JSON.parse(readMcpToolOutput(body, id))
  const call = (body, name, args, prefix = 'welcome') =>
    mcpToolRequestEvents(body, {
      toolName: name,
      directToolName: `mcp__wework_stand_in__${name}`,
      argumentsValue: args,
      searchCallId: `${prefix}-${name}-search`,
      toolCallId: `${prefix}-${name}`,
    }).events

  function configureDingTalk(body) {
    if (!has(body, 'welcome-search_connections'))
      return call(body, 'search_connections', { providerId, kind: 'group', query: 'Scoped Group' })
    if (!has(body, 'welcome-get_profile')) return call(body, 'get_profile', {})
    const group = read(body, 'welcome-search_connections').items.find(
      group => group.id === 'scoped-group'
    )
    assert.equal(group.name, 'Scoped Group')
    assert.equal(group.profile, 'fixture-org:fixture-user')
    const current = read(body, 'welcome-get_profile')
    if (!has(body, 'welcome-propose_profile')) {
      return call(body, 'propose_profile', {
        summary: '连接 Scoped Group，跟进每条新消息，发送前由你确认。',
        settings: {
          ...current,
          roles: [
            ...current.roles,
            {
              ...personalRole(current, { id: roleId, name: '上线跟进助理' }),
              prompt: launchResponsibilities,
              connections: [
                {
                  providerId,
                  id: group.id,
                  name: group.name,
                  profile: group.profile,
                  kind: 'group',
                  collectionKey: 'all-messages',
                  policy: {
                    automatic: true,
                    askBeforeAct: true,
                    immediate: true,
                    sessionStrategy: 'reuse',
                  },
                },
              ],
            },
          ],
        },
      })
    }
    return [assistantMessage('已找到 Scoped Group，确认后启用。')]
  }

  function configurePersonalRole(body) {
    if (!has(body, 'welcome-add-get_profile')) return call(body, 'get_profile', {}, 'welcome-add')
    if (has(body, 'welcome-add-propose_profile')) return [assistantMessage('请确认新助理的职责。')]
    const current = read(body, 'welcome-add-get_profile')
    const proposal = {
      summary: '添加发布说明校对助理，只处理你在对话中提供的发布说明。',
      settings: {
        ...current,
        roles: [
          ...current.roles,
          { ...personalRole(current, addedRole), prompt: '校对用户在对话中提供的发布说明。' },
        ],
      },
    }
    return call(body, 'propose_profile', proposal, 'welcome-add')
  }

  return {
    verifiesStandInOnboarding: true,
    async prepareApp(context) {
      await fixture.prepareApp(context)
      await writeFile(messagesPath, dingTalkMessages([]))
      context.appEnvironment.WEWORK_E2E_DINGTALK_GROUP_MESSAGES = messagesPath
    },
    async handleHttp(req, response, url) {
      if (!activeStory) return meeting.handleHttp(req, response, url)
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input)
      let events
      if (
        input.includes('Handle only these newly received source events') &&
        input.includes('welcome-launch-regression')
      ) {
        if (!has(body, 'welcome-read_work')) events = call(body, 'read_work', {})
        else {
          assert.ok(readMcpToolOutput(body, 'welcome-read_work').includes(sourceMessage))
          events = [
            assistantMessage(
              [
                followUp,
                '客户成功同事在等答复。复测之前若承诺今晚发布，验收未通过时需要改口。是否可以作客户承诺，请你决定。',
                `消息原文：${sourceMessage}`,
                '拟回复（待确认）：请在复测完成后同步结果，方便我确认发布窗口。',
              ].join('\n\n')
            ),
          ]
        }
      } else if (activeStory === 'dingtalk' && input.includes('找到「Scoped Group」')) {
        events = configureDingTalk(body)
      } else if (activeStory === 'add' && input.includes(addRequest)) {
        events = configurePersonalRole(body)
      } else return false
      const id = 'welcome-dingtalk-' + Date.now()
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The native model catalog provides a usable default')
      await fixture.install(control)
      await fixture.setAuthState('scoped-ready')
      await control.command('clickWhenEnabled', byId('personal-stand-in-button'))
      await control.command('waitFor', home)
      await control.command('waitFor', byId('stand-in-onboarding'), { visible: false })
      const metrics = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${home} [data-testid^="stand-in-welcome-example-"]`,
          { value: 'includeText' }
        )
      )
      assert.deepEqual(
        metrics.map(row => row.testId),
        ['stand-in-welcome-example-dingtalk_reply', 'stand-in-welcome-example-meeting_prep']
      )
      await captureScreenshot(control, '01-assistant-home.png')

      await chooseExample(control, 'dingtalk_reply')
      assert.equal(
        (await control.command('getText', input)).trim(),
        examples.dingtalk_reply.prompt.replaceAll('\n', '')
      )
      await captureScreenshot(control, '02-dingtalk-editable-draft.png')
      await control.command('fill', input, {
        value: examples.dingtalk_reply.prompt.replace('产品上线协作群', 'Scoped Group'),
      })
      const before = await load(control)
      assert.equal(before.primary.model.model_id, model.model_id)
      activeStory = 'dingtalk'
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', proposal, {
        text: 'Scoped Group',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', proposal, { text: '每条新消息', timeoutMs: uiTimeoutMs })
      await control.command('waitFor', proposal, { text: 'Fixture · Fixture Organization' })
      await control.command('waitFor', proposal, { text: '自动读取并分析，执行操作前由你确认' })
      assert.deepEqual((await load(control)).primary.connections, before.primary.connections)
      assert.ok(!(await load(control)).roles.some(role => role.id === roleId))
      await control.command('waitFor', proposal, { text: launchResponsibilities })
      await captureScreenshot(control, '03-dingtalk-confirm-in-conversation.png', proposal)
      await control.command('clickWhenEnabled', byId('stand-in-proposal-accept'))
      const applied = await storyUntil(
        () => load(control),
        settings => settings.roles.some(role => role.id === roleId),
        uiTimeoutMs,
        'The correct account and group must be saved only after confirmation'
      )
      assert.deepEqual(applied.primary.connections, before.primary.connections)
      const launchAssistant = applied.roles.find(role => role.id === roleId)
      assert.equal(launchAssistant.prompt, launchResponsibilities)
      const connection = launchAssistant.connections[0]
      assert.equal(connection.profile, 'fixture-org:fixture-user')
      assert.equal(connection.collectionKey, 'all-messages')
      assert.deepEqual(connection.policy, {
        automatic: true,
        askBeforeAct: true,
        immediate: true,
        sessionStrategy: 'reuse',
      })
      await control.command('waitFor', byId('stand-in-proposal-result'), {
        text: 'Fixture · Fixture Organization',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, '04-dingtalk-configuration-saved.png')
      await writeFile(
        messagesPath,
        dingTalkMessages([
          {
            openMessageId: 'welcome-launch-regression',
            senderOpenDingTalkId: 'fixture-colleague',
            sender: '测试同事',
            content: sourceMessage,
            createTime: new Date().toISOString(),
            sendType: 'user',
          },
        ])
      )
      const work = await storyUntil(
        async () => {
          const overview = await rpc(control, 'runtime.stand_in.work.list', { userId: STORY_USER })
          for (const work of overview.items.filter(row => row.roleId === roleId && row.task)) {
            const { messages } = await rpc(control, 'runtime.stand_in.work.messages', {
              userId: STORY_USER,
              workId: work.id,
            })
            if (JSON.stringify(messages).includes(sourceMessage)) return work
          }
          return undefined
        },
        Boolean,
        modelResponseTimeoutMs,
        'A group message without an @ must reach the configured assistant'
      )
      await storyUntil(
        () => rpc(control, 'runtime.tasks.transcript', { taskId: work.taskId, limit: 20 }),
        transcript =>
          transcript.messages?.some(
            message =>
              message.role === 'assistant' &&
              [followUp, sourceMessage, '是否可以作客户承诺，请你决定', '拟回复（待确认）'].every(
                text => message.content?.includes(text)
              )
          ),
        modelResponseTimeoutMs,
        'The private work must report the launch blocker and draft a reply'
      )
      assert.ok((await fixture.operations()).includes('selected-group-messages'))
      assert.ok(!(await fixture.operations()).includes('send'))
      activeStory = undefined

      await meeting.verify(control, model)
      await control.command('fill', input, { value: '等会儿帮我核对会后的行动清单。' })
      await control.command('clickWhenEnabled', byId('stand-in-welcome-open'))
      await control.command('clickWhenEnabled', byId('stand-in-welcome-start'))
      await control.command('waitFor', input, { text: '等会儿帮我核对会后的行动清单。' })

      const intent = byId('stand-in-chat-intent-template')
      const panel = byId('stand-in-profile-panel')
      await control.command('clickWhenEnabled', byId('stand-in-create-role'))
      await control.command('waitFor', intent, { text: '填入创建模板' })
      await control.command('waitFor', panel, { visible: false })
      await captureScreenshot(control, '08-add-assistant-in-conversation.png')

      await control.command('clickWhenEnabled', byId('stand-in-details-open'))
      await control.command('clickWhenEnabled', byId('stand-in-settings-open'))
      await control.command('waitFor', intent, { text: '填入调整模板' })
      await control.command('waitFor', panel, { visible: false })
      await control.command('clickWhenEnabled', byId('stand-in-chat-advanced'))
      await control.command('waitFor', byId('stand-in-primary-profile'))
      await captureScreenshot(control, '09-assistant-advanced-settings.png')
      await control.command('clickWhenEnabled', byId('stand-in-primary-profile-close'))
      await control.command('clickWhenEnabled', byId('stand-in-create-role'))
      await control.command('clickWhenEnabled', intent)
      await control.command('waitFor', input, { text: addPrompt })
      await control.command('fill', input, { value: addRequest })
      activeStory = 'add'
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', proposal, {
        text: addedRole.name,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.ok(!(await load(control)).roles.some(role => role.id === addedRole.id))
      await control.command('clickWhenEnabled', byId('stand-in-proposal-accept'))
      await control.command(
        'waitFor',
        byId('stand-in-overview-role-' + addedRole.id) + '[aria-current="page"]',
        { timeoutMs: uiTimeoutMs }
      )
      const newSettings = await load(control)
      assert.equal(
        newSettings.roles.find(role => role.id === addedRole.id)?.prompt,
        '校对用户在对话中提供的发布说明。'
      )
      await captureScreenshot(control, '10-new-assistant-open.png')
    },
  }
}
