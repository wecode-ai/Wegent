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
  modelMessageText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectedToolCall,
} from '../modules/response-protocol.mjs'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { createWelcomeMaterialStories } from '../modules/stand-in-welcome-materials.mjs'
import { createMeetingUserStory } from '../modules/stand-in-meeting-user-story.mjs'
import { STORY_CHAT, STORY_USER, storyUntil } from '../modules/stand-in-source-story-evidence.mjs'

const { examples, create_prompt: addPrompt } = JSON.parse(
  readFileSync(new URL('../../../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
).standIn.welcome
const providerId = '@wegent/dsh-connection-dingtalk/dingtalk'
const byId = id => `[data-testid="${id}"]`
const home = byId('stand-in-welcome')
const proposal = byId('stand-in-proposal')
const preview = `${byId('stand-in-welcome-preview')} p:last-child`
const more = byId('stand-in-welcome-more')
const library = byId('stand-in-template-library')
const input = `${STORY_CHAT} ${byId('chat-message-input')}`
const send = `${STORY_CHAT} ${byId('send-message-button')}`
const roleId = 'welcome-dingtalk-support'
const supportName = '钉钉客服助理'
const supportSetupQuestion = '请告诉我用哪个工作钉钉账号、要接入的群、运行设备和客服手册路径。'
const addedRole = { id: 'welcome-release-notes', name: '发布说明校对助理' }
const addRequest = addPrompt + '请叫它「发布说明校对助理」，只校对我在对话中发给它的发布说明。'
const launchResponsibilities =
  '读取获准的本地《产品客服手册》v3。手册明确覆盖的内容在原消息下直接回复并注明章节。没有依据、与新消息冲突、改期或客户承诺均先私下找我确认。'
const handbookQuestion = '请问今天上线的验收窗口是几点？'
const handbookReply = '根据《产品客服手册》v3 第 2 节，本次验收窗口是 18:00。'
const handbookMessageId = 'welcome-launch-handbook'
const handbookResult = '已根据手册第 2 节在原消息下答复。'
const uncertainMessageId = 'welcome-launch-regression'
const handbookContent = '《产品客服手册》v3 第 2 节：本次验收窗口是 18:00。'
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
  const featured = byId(`stand-in-welcome-example-${id}`)
  if ((await control.command('getElementCount', featured)) === '0') {
    await control.command('clickWhenEnabled', more)
    await control.command('clickWhenEnabled', byId(`stand-in-template-library-${id}`))
  } else {
    await control.command('clickWhenEnabled', featured)
  }
  await control.command('clickWhenEnabled', byId('stand-in-welcome-start'))
  await control.command('waitFor', input, { text: examples[id].prompt.split('\n')[0] })
}

export function createDesktopScenario(options) {
  const { captureScreenshot, uiTimeoutMs, modelResponseTimeoutMs, workbenchReadyTimeoutMs } =
    options
  const fixture = createStandInDingTalkFixture(options)
  const messagesPath = join(options.resultDir, 'welcome-dingtalk-messages.json')
  const handbookPath = join(options.workspacePath, 'product-support-handbook.md')
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const load = control => rpc(control, 'runtime.stand_in.personal.get', { userId: STORY_USER })
  const materialStories = createWelcomeMaterialStories({ ...options, rpc }, examples)
  const meetingRequest = examples.meeting_prep.prompt
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

  function readHandbook(body, callId) {
    const script =
      'process.stdout.write(require("node:fs").readFileSync(' +
      JSON.stringify(handbookPath) +
      ', "utf8"))'
    const encoded = Buffer.from(script).toString('base64')
    const command = `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`
    return selectedToolCall(callId, selectShellToolCommand(body, command, options.workspacePath))
  }

  function configureDingTalk(body) {
    if (!has(body, 'welcome-check-handbook')) return readHandbook(body, 'welcome-check-handbook')
    assert.ok(readMcpToolOutput(body, 'welcome-check-handbook').includes(handbookContent))
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
        summary:
          '连接 Scoped Group，跟进每条新消息，按《产品客服手册》v3 自动回复有依据的问题，其余先找你确认。',
        settings: {
          ...current,
          roles: [
            ...current.roles,
            {
              ...personalRole(current, { id: roleId, name: supportName }),
              prompt: `${launchResponsibilities} 本地路径：${handbookPath}`,
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
                    askBeforeAct: false,
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
      await writeFile(handbookPath, handbookContent)
      context.appEnvironment.WEWORK_E2E_DINGTALK_GROUP_MESSAGES = messagesPath
      context.appEnvironment.WEWORK_E2E_DINGTALK_HANDBOOK_REPLY = '1'
    },
    async handleHttp(req, response, url) {
      if (materialStories.active) return materialStories.handleHttp(req, response, url)
      if (!activeStory) return meeting.handleHttp(req, response, url)
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input)
      let events
      const event = body.input
        .map(modelMessageText)
        .reverse()
        .find(text => text.startsWith('Handle only these newly received source events'))
      if (event?.includes(uncertainMessageId)) {
        if (!has(body, 'welcome-uncertain-read_work')) {
          events = call(body, 'read_work', {}, 'welcome-uncertain')
        } else {
          assert.ok(readMcpToolOutput(body, 'welcome-uncertain-read_work').includes(sourceMessage))
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
      } else if (event?.includes(handbookMessageId)) {
        if (!has(body, 'welcome-read_work')) events = call(body, 'read_work', {})
        else if (!has(body, 'welcome-work-handbook')) {
          events = readHandbook(body, 'welcome-work-handbook')
        } else {
          const messages = read(body, 'welcome-read_work').messages
          const question = messages.find(message => message.id === handbookMessageId)
          assert.ok(question?.recordId, 'Use the original group question’s immutable record ID')
          assert.ok(JSON.stringify(question).includes(handbookQuestion))
          assert.ok(readMcpToolOutput(body, 'welcome-work-handbook').includes(handbookContent))
          if (!has(body, 'welcome-reply')) {
            events = call(body, 'reply', { messageId: question.recordId, text: handbookReply })
          } else {
            assert.ok(readMcpToolOutput(body, 'welcome-reply').includes('welcome-handbook-reply'))
            events = [assistantMessage(handbookResult)]
          }
        }
      } else if (activeStory === 'dingtalk' && input.includes('群是 Scoped Group')) {
        events = configureDingTalk(body)
      } else if (
        activeStory === 'dingtalk' &&
        body.input.map(modelMessageText).some(text => text === examples.dingtalk_reply.prompt)
      ) {
        events = [assistantMessage(supportSetupQuestion)]
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
      const featured = [
        'dingtalk_reply',
        'development',
        'daily_check',
        'knowledge',
        'weekly_review',
      ]
      const grouped = [
        'disk_space',
        'brief',
        'project',
        'weekly',
        'meeting_prep',
        'recap',
        'handoff',
        'launch',
        'reply',
        'decision',
      ]
      assert.deepEqual(
        metrics.map(row => row.testId),
        featured.map(id => `stand-in-welcome-example-${id}`)
      )
      await control.command(
        'waitFor',
        `${home}:has(canvas[data-rendered-shape="idle"], canvas[hidden])`
      )
      await control.command('waitFor', byId('stand-in-welcome-start') + ':not(:disabled)')
      await captureScreenshot(control, '01-assistant-home.png')

      for (const id of featured) {
        const selector = byId(`stand-in-welcome-example-${id}`)
        await control.command('clickWhenEnabled', selector)
        await control.command('waitFor', selector + '[aria-pressed="true"]')
        assert.equal(await control.command('getText', preview), examples[id].prompt)
        if (id === 'dingtalk_reply') {
          await control.command(
            'waitFor',
            `${home}:has(canvas[data-rendered-shape="connection"], canvas[hidden])`
          )
          await captureScreenshot(control, '01b-dingtalk-preview.png')
        }
        await control.command('clickWhenEnabled', selector)
      }
      for (const id of grouped) {
        await control.command('clickWhenEnabled', more)
        await control.command('waitFor', library)
        if (id === grouped[0]) {
          const selectors = grouped.map(id => byId(`stand-in-template-library-${id}`)).join(',')
          const rows = JSON.parse(
            await control.command('getElementMetrics', selectors, { value: 'includeText' })
          )
          assert.deepEqual(
            rows.map(row => row.testId),
            grouped.map(id => `stand-in-template-library-${id}`)
          )
          await captureScreenshot(control, '01c-template-library.png')
        }
        const selector = byId(`stand-in-template-library-${id}`)
        await control.command('clickWhenEnabled', selector)
        await control.command('waitFor', library, { visible: false })
        assert.equal(await control.command('getText', preview), examples[id].prompt)
      }

      await chooseExample(control, 'dingtalk_reply')
      assert.equal(
        (await control.command('getText', input)).trim(),
        examples.dingtalk_reply.prompt.replaceAll('\n', '')
      )
      await captureScreenshot(control, '02-dingtalk-editable-draft.png')
      const before = await load(control)
      assert.equal(before.primary.model.model_id, model.model_id)
      activeStory = 'dingtalk'
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', `${STORY_CHAT} [data-testid="message-assistant"]`, {
        text: supportSetupQuestion,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('fill', input, {
        value: `使用 Fixture 工作账号，群是 Scoped Group，在这台设备运行。手册路径：${handbookPath}`,
      })
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', proposal, {
        text: 'Scoped Group',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', proposal, { text: supportName })
      await control.command('waitFor', proposal, { text: '每条新消息', timeoutMs: uiTimeoutMs })
      await control.command('waitFor', proposal, { text: 'Fixture · Fixture Organization' })
      await control.command('waitFor', proposal, { text: '自动帮我处理' })
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
      assert.equal(launchAssistant.prompt, `${launchResponsibilities} 本地路径：${handbookPath}`)
      const connection = launchAssistant.connections[0]
      assert.equal(connection.profile, 'fixture-org:fixture-user')
      assert.equal(connection.collectionKey, 'all-messages')
      assert.deepEqual(connection.policy, {
        automatic: true,
        askBeforeAct: false,
        immediate: true,
        sessionStrategy: 'reuse',
      })
      await control.command('waitFor', byId('stand-in-proposal-result'), {
        text: 'Fixture · Fixture Organization',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, '04-dingtalk-configuration-saved.png')
      const groupMessage = (openMessageId, content) => ({
        openMessageId,
        senderOpenDingTalkId: 'fixture-colleague',
        sender: '测试同事',
        content,
        createTime: new Date().toISOString(),
        sendType: 'user',
      })
      const findWork = (question, failure) =>
        storyUntil(
          async () => {
            const overview = await rpc(control, 'runtime.stand_in.work.list', {
              userId: STORY_USER,
            })
            for (const work of overview.items.filter(row => row.roleId === roleId && row.task)) {
              const { messages } = await rpc(control, 'runtime.stand_in.work.messages', {
                userId: STORY_USER,
                workId: work.id,
              })
              if (JSON.stringify(messages).includes(question)) return work
            }
            return undefined
          },
          Boolean,
          modelResponseTimeoutMs,
          failure
        )
      const knownQuestion = groupMessage(handbookMessageId, handbookQuestion)
      await writeFile(messagesPath, dingTalkMessages([knownQuestion]))
      await storyUntil(
        () => fixture.operations(),
        operations => operations.includes('send'),
        modelResponseTimeoutMs,
        'A question covered by the approved handbook must reach the DingTalk reply protocol'
      )
      const replied = await findWork(
        handbookQuestion,
        'The handbook question must reach the scoped job'
      )
      await storyUntil(
        () => rpc(control, 'runtime.tasks.transcript', { taskId: replied.taskId, limit: 20 }),
        transcript =>
          transcript.messages?.some(
            message => message.role === 'assistant' && message.content?.includes(handbookResult)
          ),
        modelResponseTimeoutMs,
        'Wait for the reply receipt before sending another message in the same chat'
      )
      await writeFile(
        messagesPath,
        dingTalkMessages([knownQuestion, groupMessage(uncertainMessageId, sourceMessage)])
      )
      const work = await findWork(
        sourceMessage,
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
      assert.equal((await fixture.operations()).filter(operation => operation === 'send').length, 1)
      activeStory = undefined

      await meeting.verify(control, model)
      await materialStories.verify(control, model, async (control, id) => {
        await control.command('clickWhenEnabled', byId('stand-in-welcome-open'))
        await control.command('waitFor', home)
        await chooseExample(control, id)
      })
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
