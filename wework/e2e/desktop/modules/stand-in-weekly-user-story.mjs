import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { readStoryTaskEvidence } from './stand-in-private-story-evidence.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'
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

const USER = 9001
const PRIMARY = `stand-in-chat-${USER}-primary`
const REQUEST = 'WEEKLY_MONDAY_USER_STORY'
const RESULT = 'WEEKLY_MONDAY_REPORT'
const CHAT = '[data-testid="stand-in-conversation"]'

/** Only the model is scripted; scheduling, history, delivery and cancellation stay native. */
export function createWeeklyUserStory(options) {
  let active = false
  let call
  let sequence = 0
  let pageCount = 0
  const pending = []
  const taskIds = new Set()
  const messageIds = new Set()
  const cursors = new Set()
  const evidence = []
  const deliveries = new Map()
  const parentAnswers = new Set()
  const emitCall = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  const nextCall = (body, name, args) => {
    call = { name, args, id: `weekly-story-${++sequence}` }
    return emitCall(body)
  }
  function readPage(body) {
    if (!call) return nextCall(body, 'list_tasks', {})
    if (!requestContainsToolOutput(body, call.id)) return emitCall(body)
    const page = JSON.parse(readMcpToolOutput(body, call.id))
    if (call.name === 'list_tasks') {
      for (const task of page.items) taskIds.add(task.taskId)
      if (page.hasMore) {
        assert.equal(typeof page.nextCursor, 'string')
        return nextCall(body, 'list_tasks', { cursor: page.nextCursor })
      }
      assert.ok(taskIds.has(PRIMARY), 'The scheduled reader must discover the real owner chat')
      return nextCall(body, 'read_task', { taskId: PRIMARY, limit: 2 })
    }
    assert.equal(page.success, true)
    assert.equal(page.taskId, PRIMARY)
    if (Array.isArray(page.messages)) {
      pageCount++
      for (const message of page.messages) {
        assert.ok(['user', 'assistant'].includes(message.role))
        assert.ok(!messageIds.has(message.id), 'Native history pages must not repeat messages')
        messageIds.add(message.id)
        evidence.push(message.content)
        if (message.contentComplete === false) {
          assert.equal(typeof message.messageContentCursor, 'string')
          pending.push({ messageContentCursor: message.messageContentCursor })
        }
      }
      if (page.hasMoreBefore) {
        assert.equal(typeof page.beforeCursor, 'string')
        assert.ok(!cursors.has(page.beforeCursor), 'Native history pagination must advance')
        cursors.add(page.beforeCursor)
        pending.push({ beforeCursor: page.beforeCursor, limit: 2 })
      }
    } else {
      assert.equal(typeof page.content, 'string')
      evidence.push(page.content)
      if (page.contentComplete === false) {
        assert.equal(typeof page.messageContentCursor, 'string')
        pending.unshift({ messageContentCursor: page.messageContentCursor })
      }
    }
    if (pending.length) return nextCall(body, 'read_task', { taskId: PRIMARY, ...pending.shift() })
    assert.ok(pageCount >= 2, 'The new story must traverse actual native history pages')
    assert.ok(evidence.join('\n').includes('MEMORY_VERIFY_'), 'Read actual preceding owner work')
    return [
      assistantMessage(
        `${RESULT}：已逐页核对本设备过去七天的工作对话，包括记忆设置的实际请求与结果。没有独立证据表明这些配置验证是你的工作习惯问题，本次不强凑改进建议。`
      ),
    ]
  }
  return {
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
      const latest = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const text =
        typeof latest?.content === 'string'
          ? latest.content
          : (latest?.content ?? []).map(part => part.text ?? '').join('')
      const notification = text.match(
        /^Wework delegated task result: resultId=([^,\s]+), taskId=([^,\s]+), status=done,/
      )
      let events
      if (notification) {
        const [, resultId, taskId] = notification
        deliveries.set(resultId, taskId)
        events = delegatedTaskResultEvents(body)
        if (JSON.stringify(events).includes(RESULT)) parentAnswers.add(resultId)
      } else if (
        JSON.stringify(body.input ?? []).includes(REQUEST) &&
        JSON.stringify(body.input ?? []).includes('The host fixes the read window')
      ) {
        events = readPage(body)
      } else return false
      const id = `weekly-story-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, openCalendarReviewTemplate, timeZone) {
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await openCalendarReviewTemplate(control)
      const prompt = await control.command('getValue', '[data-testid="automation-prompt-input"]')
      await control.command('fill', '[data-testid="automation-name-input"]', {
        value: '每周工作复盘 · 周一09:00',
      })
      await control.command('fill', '[data-testid="automation-prompt-input"]', {
        value: `${prompt}\n${REQUEST}`,
      })
      await control.command('click', '[data-testid="automation-cron-time"]')
      await control.command('scrollIntoView', '[data-testid="automation-cron-time-option-09:00"]')
      await control.command('clickWhenEnabled', '[data-testid="automation-cron-time-option-09:00"]')
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      const schedule = (await rpc('runtime.automations.list', {})).items.find(item =>
        item.prompt.includes(REQUEST)
      )
      assert.ok(schedule)
      assert.equal(schedule.enabled, true)
      assert.equal(schedule.schedule.expression, '0 9 * * 1')
      assert.equal(schedule.timezone, timeZone)
      assert.deepEqual(schedule.taskRequest.standInOwner, { userId: USER, roleId: '@primary' })
      const next = new Date(schedule.nextRunAt)
      assert.equal(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(next),
        'Mon 09:00'
      )
      active = true
      try {
        await control.command('click', `[data-testid="automation-open-${schedule.id}"]`)
        await control.command('click', `[data-testid="automation-detail-actions-${schedule.id}"]`)
        await control.command('clickWhenEnabled', '[data-testid="automation-run-now-button"]')
        await control.command('waitFor', '[data-testid="automation-run-history"]', {
          text: '已完成',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const runs = (await rpc('runtime.automation_runs.list', { automationId: schedule.id }))
          .items
        assert.equal(runs.length, 1, 'One Run now click must create exactly one native run')
        const [run] = runs
        assert.equal(run.status, 'succeeded')
        assert.ok(run.taskId)
        await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
        await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
          visible: false,
        })
        await control.command('waitFor', CHAT, {
          text: RESULT,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const child = await until(
          () => readStoryTaskEvidence(options.executorHome, run.taskId),
          result => Boolean(result?.receipt),
          'The exact scheduled completion must persist its parent delivery receipt',
          options.modelResponseTimeoutMs
        )
        const receipt = child.receipt
        const completion = child.completion
        assert.equal(completion.status, 'done')
        const publicChild = (await rpc('runtime.tasks.get', { taskId: run.taskId })).task
        assert.equal(publicChild.status, 'done')
        assert.equal(publicChild.runtimeHandle.lastTurnId, completion.turnId)
        assert.equal(completion.turnId, child.lastTurnId)
        assert.ok(completion.turnId)
        assert.deepEqual(completion.generation.reportTo, { userId: USER, taskId: PRIMARY })
        assert.equal(deliveries.get(receipt), run.taskId)
        assert.deepEqual([...parentAnswers], [receipt])
        const transcript = await rpc('runtime.tasks.transcript', { taskId: PRIMARY, limit: 100 })
        assert.equal(
          transcript.messages.filter(
            message => message.role === 'assistant' && JSON.stringify(message).includes(RESULT)
          ).length,
          1,
          'The owner receives the actual report once, without another prompt'
        )
        await options.captureScreenshot(control, 'weekly-story-result-in-primary.png')
        await openStandInSettings(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-connections-open"]'
        )
        await openConnectionTypePicker(control)
        await control.command('click', '[data-testid="stand-in-time-connections"]')
        await control.command('clickWhenEnabled', `[data-testid="automation-open-${schedule.id}"]`)
        await control.command('click', `[data-testid="automation-detail-toggle-${schedule.id}"]`)
        await control.command('waitFor', '[data-testid="automation-detail-panel"]', {
          text: '已暂停',
        })
        const paused = (await rpc('runtime.automations.get', { automationId: schedule.id }))
          .automation
        assert.equal(paused.enabled, false)
        assert.equal(
          paused.nextRunAt,
          null,
          'Cancellation must remove the next scheduled execution'
        )
        assert.equal(
          (await rpc('runtime.automations.delete', { automationId: schedule.id })).deleted,
          true
        )
        await assert.rejects(
          rpc('runtime.automations.run_now', { automationId: schedule.id }),
          /not_found|not found/
        )
        assert.deepEqual(
          (await rpc('runtime.automation_runs.list', { automationId: schedule.id })).items.map(
            item => item.id
          ),
          [run.id],
          'A cancelled arrangement cannot create another run or repeat its delivered report'
        )
      } finally {
        active = false
        await rpc('runtime.automations.delete', { automationId: schedule.id })
      }
    },
  }
}
