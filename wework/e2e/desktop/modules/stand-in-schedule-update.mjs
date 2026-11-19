import { desktopOwnerId } from './desktop-owner-fixture.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { isNativeApprovalReviewRequest } from './native-approval-model.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
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
} from './response-protocol.mjs'

const MARKER = 'SCHEDULE_UPDATE_KEEP_EXISTING'
const RESULT = 'SCHEDULE_UPDATE_SAVED'
const ID = 'e2e-stand-in-schedule-update'
const MESSAGE =
  '日报卡点按事项、当前责任人、等待谁配合、等待时长、下一步展示；没有证据的归属标注责任人待确认。'

/** Add real MCP update coverage to the existing CI scenario, sharing its running app. */
export function withScheduleUpdate(scenario, options) {
  let active = false
  let call
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  return {
    ...scenario,
    async handleHttp(req, response, url) {
      if (active && req.method === 'POST' && /\/responses$/.test(url.pathname)) {
        const body = await readRequestBody(req)
        if (handleModelMaintenanceRequest(body, response)) return true
        if (isNativeApprovalReviewRequest(body)) return false
        if (!isReplyPredictionRequest(body) && JSON.stringify(body.input ?? []).includes(MARKER)) {
          let events
          if (!call) {
            call = { id: 'schedule-update-list', name: 'list_schedules', args: {} }
            events = emit(body)
          } else if (!requestContainsToolOutput(body, call.id)) {
            events = emit(body)
          } else {
            const result = JSON.parse(readMcpToolOutput(body, call.id))
            if (call.name === 'list_schedules') {
              const saved = result.items.find(item => item.id === ID)
              assert.ok(saved)
              assert.equal(saved.message, '原日报内容')
              assert.equal(typeof saved.version, 'number')
              call = {
                id: 'schedule-update-write',
                name: 'update_schedule',
                args: {
                  scheduleId: saved.id,
                  version: saved.version,
                  message: MESSAGE,
                },
              }
              events = emit(body)
            } else {
              assert.equal(result.automation.id, ID)
              assert.equal(result.automation.prompt, MESSAGE)
              events = [assistantMessage(RESULT)]
            }
          }
          const id = `schedule-update-response-${Date.now()}`
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
          return true
        }
      }
      return scenario.handleHttp(req, response, url)
    },
    async verify(control) {
      await scenario.verify(control)
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      const saved = (
        await rpc('runtime.automations.create', {
          automation: {
            id: ID,
            version: 0,
            name: '日报更新验证',
            prompt: '原日报内容',
            enabled: true,
            schedule: { type: 'one_time', execute_at: '2099-01-01T10:00:00Z' },
            timezone: 'Asia/Shanghai',
            conversationMode: 'independent',
            notificationPolicy: 'attention_only',
            taskRequest: {
              schemaVersion: 2,
              runtime: 'codex',
              title: '日报更新验证',
              message: '原日报内容',
              standInOwner: { userId: desktopOwnerId, roleId: '@primary' },
              standInCalendar: {},
            },
            taskPayload: { runtime: 'codex' },
          },
        })
      ).automation
      const ids = async () =>
        (await rpc('runtime.automations.list', {})).items.map(item => item.id).sort()
      const before = await ids()
      active = true
      try {
        await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
        const profile = '[data-testid="stand-in-profile-panel"]'
        if (Number(await control.command('getElementCount', profile, { visible: true })) > 0) {
          await control.command(
            'clickWhenEnabled',
            '[data-testid="stand-in-primary-profile-close"]'
          )
          await control.command('waitFor', profile, { visible: false })
        }
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
        const chat = '[data-testid="stand-in-conversation"]'
        await control.command(
          'fill',
          `${chat} [data-testid="chat-message-input"][contenteditable="true"]`,
          {
            value: `${MARKER}：将日报补充为“${MESSAGE}”，保留原来的时间、启用状态和安排。`,
          }
        )
        await control.command('clickWhenEnabled', `${chat} [data-testid="send-message-button"]`)
        await control.command('waitFor', '[data-testid="stand-in-conversation"]', {
          text: RESULT,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        const updated = (await rpc('runtime.automations.get', { automationId: ID })).automation
        assert.equal(updated.prompt, MESSAGE)
        assert.equal(updated.taskRequest.message, MESSAGE)
        assert.equal(updated.version, saved.version + 1)
        for (const key of [
          'id',
          'name',
          'createdAt',
          'schedule',
          'timezone',
          'enabled',
          'nextRunAt',
        ]) {
          assert.deepEqual(updated[key], saved[key], key)
        }
        assert.deepEqual(await ids(), before, 'Updating must not create or delete arrangements')
        assert.deepEqual(updated.taskRequest.standInOwner, saved.taskRequest.standInOwner)
      } finally {
        active = false
        await rpc('runtime.automations.delete', { automationId: ID })
      }
    },
  }
}
