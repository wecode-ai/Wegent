import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStandInDingTalkFixture } from './stand-in-dingtalk-fixture.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  modelMessageText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectShellToolCommand,
} from './response-protocol.mjs'
import { STORY_CHAT, STORY_USER, storyUntil } from './stand-in-source-story-evidence.mjs'

const { prompt } = JSON.parse(
  readFileSync(new URL('../../../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
).standIn.welcome.examples.daily_check
const EMAIL = '@wegent/dsh-connection-runtime/email'
const DINGTALK = '@wegent/dsh-connection-dingtalk/dingtalk'
const WORK = '每日 17 点核对已授权邮箱、钉钉群和工作日历'
const SETUP = '请确认使用当前邮箱、钉钉工作群和主日历的时间范围。'
const CONFIRMED = '确认每日检查使用当前邮箱、Scoped Group 和工作主日历'
const TITLE = '每天 17:00 检查漏事'
const RESULT = '今天还有三项未完成'
const MAIL_SUBJECT = 'DAILY_CHECK：采购审批等你确认'
const GROUP_TEXT = 'DAILY_CHECK：请在下班前回复验收安排。'
const CALENDAR_EVENT = 'DAILY_CHECK：评审会后的动作尚未指定负责人'
const byId = id => `[data-testid="${id}"]`
const input = `${STORY_CHAT} ${byId('chat-message-input')}`
const send = `${STORY_CHAT} ${byId('send-message-button')}`
const answer = `${STORY_CHAT} ${byId('message-assistant')}`
const has = requestContainsToolOutput
const output = (body, id) => JSON.parse(readMcpToolOutput(body, id))
const call = (body, id, tool, args) =>
  mcpToolRequestEvents(body, {
    toolName: tool,
    directToolName: `mcp__wework_stand_in__${tool}`,
    argumentsValue: args,
    searchCallId: `${id}-search`,
    toolCallId: id,
  }).events

export function createWelcomeDailyCheck(options) {
  const fixture = createStandInDingTalkFixture(options)
  const groupPath = join(options.resultDir, 'daily-check-dingtalk-messages.json')
  let active = false
  let schedule, selected, since, start, dws

  function getInputs(body) {
    const email = 'daily-check-real-mail'
    const group = 'daily-check-real-group'
    const calendar = 'daily-check-calendar'
    if (!has(body, email))
      return call(body, email, 'read_source', { source: selected[0], query: { since } })
    if (!has(body, group))
      return call(body, group, 'read_source', { source: selected[1], query: { since } })
    if (!has(body, calendar)) {
      const script = `const cp=require('node:child_process'); console.log('CALENDAR_RESULT:' +
        cp.execFileSync(${JSON.stringify(dws)}, [
        'calendar','event','list','--calendar-id','primary','--start',${JSON.stringify(start)},
        '--end',${JSON.stringify(new Date().toISOString())},'--format','json'
      ],{encoding:'utf8'}).trim())`
      const encoded = Buffer.from(script).toString('base64')
      const command = `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`
      return selectedToolCall(
        calendar,
        selectShellToolCommand(body, command, options.workspacePath)
      )
    }
    const mail = output(body, email).items.find(item => item.subject === MAIL_SUBJECT)
    const message = output(body, group).items.find(item => item.text === GROUP_TEXT)
    const calendarResult = readMcpToolOutput(body, calendar).match(/CALENDAR_RESULT:([^\r\n]+)/)
    assert.ok(calendarResult)
    const event = JSON.parse(calendarResult[1]).result.find(item => item.summary === CALENDAR_EVENT)
    assert.ok(mail && message && event, 'Read live test records from all three sources')
    return [
      assistantMessage(
        `${RESULT}。1. ${mail.subject}（邮件 ${mail.id}）。2. ${message.text}（钉钉 ${message.id}）。3. ${event.summary}（日程 ${event.id}）。`
      ),
    ]
  }

  function arrange(body) {
    if (!has(body, 'daily-check-get-profile'))
      return call(body, 'daily-check-get-profile', 'get_profile', {})
    if (!has(body, 'daily-check-save-schedule')) {
      const { primary } = output(body, 'daily-check-get-profile')
      selected = [EMAIL, DINGTALK].map(provider =>
        Object.fromEntries(
          ['providerId', 'profile', 'kind', 'id'].map(key => [
            key,
            primary.connections.find(row => row.providerId === provider)[key],
          ])
        )
      )
      return call(body, 'daily-check-save-schedule', 'schedule_task', {
        requestId: 'welcome-daily-check-17h',
        title: TITLE,
        message: WORK,
        cron: '0 17 * * *',
        timezone: 'Asia/Shanghai',
        readSources: selected,
      })
    }
    schedule = output(body, 'daily-check-save-schedule').automation
    assert.ok(schedule?.id)
    return [assistantMessage('已安排每天 17:00 检查漏事。')]
  }

  return {
    async prepareApp(context) {
      await fixture.prepareApp(context)
      dws = context.appEnvironment.DWS_BINARY_PATH
      context.appEnvironment.WEWORK_E2E_DINGTALK_GROUP_MESSAGES = groupPath
      context.appEnvironment.WEWORK_E2E_DINGTALK_CALENDAR = '1'
      await writeFile(
        groupPath,
        JSON.stringify({ success: true, result: { conversationMessagesList: [], hasMore: false } })
      )
    },
    async handleHttp(req, response, url) {
      if (
        !active ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const text = modelMessageText(body.input?.filter(item => item.role === 'user').at(-1))
      let events
      if (text === prompt) events = [assistantMessage(SETUP)]
      else if (text.startsWith(CONFIRMED)) events = arrange(body)
      else if (text.includes(WORK) && schedule) events = getInputs(body)
      else if (text.startsWith('Wework delegated task result:') && schedule)
        events = delegatedTaskResultEvents(body)
      if (!events) return false
      const id = `daily-check-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, rpc, mail) {
      const original = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
      const now = new Date()
      // Run immediately at a known confirmation time but preserve the saved 17:00 trigger.
      const date = new Intl.DateTimeFormat('en-CA', {
        dateStyle: 'short',
        timeZone: 'Asia/Shanghai',
      }).format(now)
      const localDay = new Intl.DateTimeFormat('sv-SE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(now)
      start = `${localDay}T00:00:00+08:00`
      since = new Date(start).toISOString()
      await fixture.install(control)
      await fixture.setAuthState('scoped-ready')
      const group = {
        providerId: DINGTALK,
        kind: 'group',
        profile: 'fixture-org:fixture-user',
        id: 'scoped-group',
        name: 'Scoped Group',
        collectionKey: 'all-messages',
        policy: {
          automatic: false,
          askBeforeAct: true,
          immediate: false,
          sessionStrategy: 'reuse',
        },
      }
      try {
        await rpc('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: {
            ...original,
            primary: {
              ...original.primary,
              enabled: true,
              connections: [...original.primary.connections, group],
            },
          },
        })
        await mail.append(
          MAIL_SUBJECT,
          '请在今天 17:00 前核对报价。',
          '<daily-check-current@example.com>',
          now
        )
        await writeFile(
          groupPath,
          JSON.stringify({
            success: true,
            result: {
              hasMore: false,
              nextCursor: '0',
              conversationMessagesList: [
                {
                  openConversationId: 'scoped-group',
                  singleChat: false,
                  messages: [
                    {
                      openMessageId: 'daily-check-group-message',
                      senderOpenDingTalkId: 'fixture-colleague',
                      sender: '测试同事',
                      content: GROUP_TEXT,
                      createTime: now.toISOString(),
                      sendType: 'user',
                    },
                  ],
                },
              ],
            },
          })
        )
        active = true
        await control.command('clickWhenEnabled', byId('stand-in-welcome-open'))
        await control.command('clickWhenEnabled', byId('stand-in-welcome-example-daily_check'))
        await control.command('clickWhenEnabled', byId('stand-in-welcome-start'))
        assert.equal(await control.command('getText', input), prompt.replaceAll('\n', ''))
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', answer, {
          text: SETUP,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await control.command('fill', input, {
          value: `${CONFIRMED}，时区 Asia/Shanghai，今天是 ${date}。`,
        })
        await control.command('clickWhenEnabled', send)
        await control.command('waitFor', answer, {
          text: '已安排每天 17:00 检查漏事',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.equal(schedule.schedule.expression, '0 17 * * *')
        assert.equal(schedule.taskRequest.standInCalendar.readSources.length, 2)
        const receipt = await rpc('runtime.automations.run_now', { automationId: schedule.id })
        assert.ok(receipt.run?.id)
        await storyUntil(
          async () =>
            (await rpc('runtime.automation_runs.list', { automationId: schedule.id })).items.find(
              item => item.id === receipt.run.id
            ),
          run => run?.status === 'succeeded',
          options.modelResponseTimeoutMs,
          'Daily check must actually complete the immediate run'
        )
        for (const text of [RESULT, MAIL_SUBJECT, GROUP_TEXT, CALENDAR_EVENT])
          await control.command('waitFor', answer, {
            text,
            timeoutMs: options.modelResponseTimeoutMs,
          })
        assert.ok(!(await fixture.operations()).includes('send'))
        console.info(
          '[assistant-home-story] daily_check: original template, Run now, actual email and DingTalk protocol reads'
        )
      } finally {
        active = false
        if (schedule) await rpc('runtime.automations.delete', { automationId: schedule.id })
        const current = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
