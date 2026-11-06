import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { readStoryTaskEvidence } from './stand-in-private-story-evidence.mjs'
import {
  STORY_USER,
  STORY_PRIMARY,
  STORY_CHAT,
  openStoryPrimary,
  assertStoryPrimaryOutcome,
  restoreSourceStory,
  storyUntil,
} from './stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const PROVIDER = '@wegent/dsh-connection-runtime/email'
const MARKER = 'DAILY_BRIEF_SOURCE_STORY'
const REQUEST = '综合我的邮件、日历和项目动态，列出今天最重要的三件事，并附上来源。'
const DAY = 86400000
const output = (body, id) => JSON.parse(readMcpToolOutput(body, id))
const has = requestContainsToolOutput
const call = (body, id, name, args) =>
  mcpToolRequestEvents(body, {
    toolName: name,
    directToolName: `mcp__wework_stand_in__${name}`,
    argumentsValue: args,
    searchCallId: `${id}-search`,
    toolCallId: id,
  }).events

/** A normal brief must cover recent unfinished responsibility, not only today's arrivals. */
export function createDailyBriefStory(options) {
  const state = { active: false, source: null, taskId: null, since: null, report: null }
  const rows = new Map()
  const cursors = new Set()
  let page = 0
  let intakeRound = 0
  function owner(body) {
    if (!has(body, `${MARKER}-profile`)) return call(body, `${MARKER}-profile`, 'get_profile', {})
    const profile = output(body, `${MARKER}-profile`)
    const source = profile.primary.connections.find(item => item.providerId === PROVIDER)
    assert.ok(source, 'Discover the actual saved account through the native profile tool')
    state.source = Object.fromEntries(
      ['providerId', 'profile', 'kind', 'id'].map(key => [key, source[key]])
    )
    if (!has(body, `${MARKER}-create`))
      return call(body, `${MARKER}-create`, 'create_task', {
        requestId: MARKER,
        title: '今日要事简报',
        message: `${MARKER}: ${REQUEST}`,
        readSources: [state.source],
      })
    state.taskId = output(body, `${MARKER}-create`).taskId
    assert.equal(typeof state.taskId, 'string')
    return [assistantMessage('正在核对近期仍需处理的事项，完成后会把具体结果告诉你。')]
  }
  function worker(body) {
    const id = `${MARKER}-page-${page}`
    if (!has(body, id))
      return call(body, id, 'read_source', {
        source: state.source,
        ...(page ? { cursor: [...cursors].at(-1) } : { query: { since: state.since, limit: 2 } }),
      })
    const result = output(body, id)
    assert.ok(Array.isArray(result.items), 'Read source must return real provider data')
    assert.equal(result.readOnly, true)
    assert.ok(result.items.length <= 2)
    for (const item of result.items) {
      assert.ok(!rows.has(item.id), 'Opaque source pages must not repeat mail IDs')
      rows.set(item.id, item)
    }
    if (result.hasMore) {
      assert.equal(typeof result.nextCursor, 'string')
      assert.ok(!cursors.has(result.nextCursor), 'Source cursor must advance')
      cursors.add(result.nextCursor)
      page++
      return worker(body)
    }
    assert.ok(page >= 1, 'The carryover message must be reached through real IMAP pagination')
    const messages = [...rows.values()]
      .filter(item => item.subject.startsWith(MARKER))
      .map(item => ({ ...item, details: JSON.parse(item.text.trim()) }))
    assert.equal(messages.length, 3)
    const urgent = messages.filter(item => item.details.status === 'pending')
    assert.equal(urgent.length, 1, 'Only the still-unfinished responsibility is urgent')
    assert.ok(messages.some(item => item.details.status === 'completed'))
    assert.ok(messages.some(item => item.details.status === 'routine'))
    const [item] = urgent
    assert.ok(Date.parse(item.at) < Date.now() - DAY, 'The urgent item predates today')
    assert.ok(Date.parse(item.at) >= Date.parse(state.since))
    state.report = `今天优先处理：${item.details.action}，截止${item.details.deadline}。来源：邮件 ${item.id}。已完成的记录和常规通知不列为紧急待办；本次未读取日历及项目，不能据此断言没有其他安排。`
    return [assistantMessage(state.report)]
  }
  function coordinator(body) {
    const read = `${MARKER}-intake-${intakeRound}`,
      ignored = `${read}-ignore`
    if (has(body, ignored)) {
      assert.equal(output(body, ignored).status, 'pending')
      intakeRound++
      return [assistantMessage('本批变化无需另建工作。')]
    }
    if (!has(body, read)) return call(body, read, 'read_intake', {})
    return call(body, ignored, 'ignore_events', {
      eventIds: output(body, read).snapshot.events.map(item => item.id),
      reason: '测试中的显式简报请求正在原有独立工作中处理，不重复派发。',
    })
  }
  return {
    async handleHttp(req, response, url) {
      if (
        !state.active ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const latest = body.input?.filter(item => item.role === 'user').at(-1)
      const text =
        typeof latest?.content === 'string'
          ? latest.content
          : (latest?.content ?? []).map(part => part.text ?? '').join('')
      let events = delegatedTaskResultEvents(body)
      if (!events) {
        if (text.startsWith('Review this silent intake batch')) events = coordinator(body)
        else if (text.includes(REQUEST) && !text.includes(`${MARKER}:`)) events = owner(body)
        else if (JSON.stringify(body.input ?? []).includes(`${MARKER}:`)) events = worker(body)
        else return false
      }
      const id = `${MARKER}-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, rpc, mail, model) {
      const original = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
      const source = original.primary.connections.find(item => item.providerId === PROVIDER)
      assert.ok(source)
      const now = Date.now()
      state.since = new Date(now - 3 * DAY).toISOString()
      const fixtures = [
        {
          status: 'pending',
          action: '完成此前转来的预算审批',
          deadline: '今天16:00',
          age: 2 * DAY,
        },
        { status: 'completed', action: '已完成的采购确认', deadline: '昨天18:00', age: DAY },
        { status: 'routine', action: '本周产品资讯', deadline: '无', age: 1000 },
      ]
      const smtpBefore = (await mail.received()).length
      state.active = true
      try {
        await rpc('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: {
            ...original,
            primary: { ...original.primary, enabled: true, model },
            roles: original.roles.map(role => ({ ...role, enabled: false })),
          },
        })
        for (const fixture of fixtures) {
          const { age, ...details } = fixture
          const internalDate = new Date(now - age)
          // Exercise IMAP's 24-hour noon boundary regardless of the CI clock.
          if (details.status === 'pending') internalDate.setUTCHours(12, 33, 30, 0)
          await mail.append(
            `${MARKER} ${details.status}`,
            JSON.stringify(details),
            `<daily-${details.status}@example.com>`,
            internalDate
          )
        }
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1280, height: 800 }),
        })
        await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
        await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
          visible: false,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await openStoryPrimary(control)
        await control.command('fill', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          value: REQUEST,
        })
        await control.command(
          'clickWhenEnabled',
          `${STORY_CHAT} [data-testid="send-message-button"]`
        )
        await control.command('waitFor', `${STORY_CHAT} [data-testid="message-assistant"]`, {
          text: '今天优先处理：完成此前转来的预算审批',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        assert.ok(state.report)
        assert.deepEqual(
          state.source,
          Object.fromEntries(['providerId', 'profile', 'kind', 'id'].map(key => [key, source[key]]))
        )
        await assertStoryPrimaryOutcome(control, rpc, state.report, options.modelResponseTimeoutMs)
        const child = await storyUntil(
          () => readStoryTaskEvidence(options.executorHome, state.taskId),
          result => Boolean(result?.receipt),
          options.modelResponseTimeoutMs,
          'The brief must persist the exact native parent-delivery receipt'
        )
        assert.equal(child.completion.status, 'done')
        const publicChild = (await rpc('runtime.tasks.get', { taskId: state.taskId })).task
        assert.equal(publicChild.status, 'done')
        assert.equal(publicChild.runtimeHandle.lastTurnId, child.completion.turnId)
        assert.equal(child.completion.turnId, child.lastTurnId)
        assert.ok(child.completion.turnId)
        assert.equal(child.completion.generation.delegation.sourceTaskId, STORY_PRIMARY)
        assert.deepEqual(child.delegation.readSources, [state.source])
        assert.equal(
          (await mail.received()).length,
          smtpBefore,
          'A brief must never send SMTP mail'
        )
        await options.captureScreenshot(control, 'daily-brief-carryover-result-in-primary.png')
      } finally {
        await restoreSourceStory(rpc, original, state)
      }
    },
  }
}
