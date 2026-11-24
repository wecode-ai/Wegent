import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { CLOUD_DEVICE_ID, fetchJson, waitForLogPattern } from '../modules/shared.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const REQUEST = '请交给跨设备发布工程，核实周五的发布窗口。'
const BRIEF = '核实周五发布窗口，并回报环境及可用时间。'
const QUEUED = '跨设备发布工程的任务已排队，设备上线后自动开始。'
const RESULT = '周五下午发布窗口可用。'
const FINAL = '跨设备发布工程已确认，周五下午可以发布。'
const testId = id => `[data-testid=${JSON.stringify(id)}]`
const ROOT = testId('stand-in-overview')
const CHAT = `${ROOT} ${testId('stand-in-conversation')}`
const CARD = `${CHAT} ${testId('stand-in-delegated-work')}`
const TOGGLE = `${CARD} [data-testid="stand-in-delegated-work-toggle"]`
const ROW = `${CARD} ${testId('stand-in-delegated-work-open')}`
const CANCEL_REQUEST = '请交给跨设备发布工程，核对下周一的发布窗口。'
const CANCEL_BRIEF = '核对下周一的独立排期。'
const DEPENDENCY_REQUEST = '先请发布工程验证周四窗口，再请它据此拟定值班时间。'
const DEPENDENCY_WORK = [
  { title: '验证周四窗口', message: '查证周四窗口开放时间。' },
  { title: '拟定周四值班时间', message: '依据实际窗口结果拟定值班时间。' },
]
const VERIFIED_WINDOW = '周四 14:00 开放窗口。'
const DEPENDENCY_FINAL = '值班从周四 14:00 开始。'

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let cloud
  let roleId
  let taskId
  let workerTurns = 0
  let deliveries = 0
  let sequence = 0
  const dependencies = []
  const dependencyRuns = [0, 0]
  const work = Promise.withResolvers()
  const reply = (response, events) => {
    const id = `cross-device-role-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }

  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    cleanup() {
      work.resolve()
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (
        handleModelMaintenanceRequest(body, response) ||
        handleEmptyReplyPrediction(body, response)
      ) {
        return true
      }
      const input = Array.isArray(body.input) ? body.input : []
      const latest = JSON.stringify(input.filter(item => item.role === 'user').at(-1) ?? '')
      assert.ok(!latest.includes(CANCEL_BRIEF), 'The cancelled offline task must never start')
      if (latest.includes('A specialist task on another device has finished.')) {
        if (latest.includes(DEPENDENCY_WORK[1].title)) {
          assert.ok(latest.includes(DEPENDENCY_FINAL))
          reply(response, [assistantMessage(DEPENDENCY_FINAL)])
          return true
        }
        if (latest.includes(DEPENDENCY_WORK[0].title)) {
          reply(response, [])
          return true
        }
        assert.ok(latest.includes(RESULT), 'A recorded conclusion must reach the original turn')
        deliveries++
        reply(response, [assistantMessage(FINAL)])
        return true
      }
      if (latest.includes(BRIEF)) {
        assert.ok(
          JSON.stringify(input).includes(dirname(cloud.remoteCodexHome)),
          'The role must execute in the configured cloud Executor home'
        )
        workerTurns++
        await work.promise
        reply(response, [assistantMessage(RESULT)])
        return true
      }
      for (const [index, item] of DEPENDENCY_WORK.entries()) {
        if (!latest.includes(item.message)) continue
        dependencyRuns[index]++
        if (index === 0 && dependencyRuns[index] === 1) {
          const id = `cross-device-error-${++sequence}`
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.end(
            createSse([
              responseCreated(id),
              {
                type: 'response.failed',
                response: {
                  id,
                  status: 'failed',
                  error: {
                    code: 'invalid_prompt',
                    message: 'The model rejected the first execution attempt.',
                  },
                },
              },
            ])
          )
        } else if (index === 0) {
          reply(response, [assistantMessage(VERIFIED_WINDOW)])
        } else {
          assert.ok(
            latest.includes(VERIFIED_WINDOW),
            'The remote dependent needs the actual recorded result'
          )
          reply(response, [assistantMessage(DEPENDENCY_FINAL)])
        }
        return true
      }
      if (latest.includes(DEPENDENCY_REQUEST)) {
        for (const [index, item] of DEPENDENCY_WORK.entries()) {
          const id = `remote-dependency-${index}`
          if (!requestContainsToolOutput(body, id)) {
            const { events } = mcpToolRequestEvents(body, {
              toolName: 'delegate_role_task',
              directToolName: 'mcp__wework_stand_in__delegate_role_task',
              argumentsValue: {
                roleId,
                requestId: id,
                ...item,
                ...(index ? { dependsOn: [dependencies[0]] } : {}),
              },
              searchCallId: `${id}-search`,
              toolCallId: id,
            })
            reply(response, events)
            return true
          }
          const dispatch = JSON.parse(readMcpToolOutput(body, id))
          assert.equal(dispatch.accepted, true)
          assert.equal(dispatch.deviceId, CLOUD_DEVICE_ID)
          if (index) assert.equal(dispatch.status, 'waiting_for_dependencies')
          dependencies[index] = dispatch.taskId
        }
        reply(response, [assistantMessage('已安排验证窗口与拟定值班时间。')])
        return true
      }
      const cancellationStory = latest.includes(CANCEL_REQUEST)
      if (!latest.includes(REQUEST) && !cancellationStory) return false
      const prefix = cancellationStory ? 'cancel-specialist' : 'remote-specialist'
      const dispatchCall = `${prefix}-dispatch`
      const directoryCall = `${prefix}-directory`
      if (requestContainsToolOutput(body, dispatchCall)) {
        const dispatch = JSON.parse(readMcpToolOutput(body, dispatchCall))
        assert.equal(dispatch.accepted, true)
        assert.equal(dispatch.status, 'waiting_for_device')
        assert.equal(dispatch.deviceId, CLOUD_DEVICE_ID)
        taskId = dispatch.taskId
        reply(response, [assistantMessage(QUEUED)])
        return true
      }
      const directoryReady = requestContainsToolOutput(body, directoryCall)
      if (directoryReady) {
        const { roles } = JSON.parse(readMcpToolOutput(body, directoryCall))
        assert.ok(roles.some(role => role.id === roleId && role.deviceId === CLOUD_DEVICE_ID))
      }
      const toolName = directoryReady ? 'delegate_role_task' : 'list_delegate_roles'
      const callId = directoryReady ? dispatchCall : directoryCall
      const { events } = mcpToolRequestEvents(body, {
        toolName,
        directToolName: `mcp__wework_stand_in__${toolName}`,
        argumentsValue: directoryReady
          ? cancellationStory
            ? {
                roleId,
                requestId: 'monday-window',
                title: '核对下周一发布窗口',
                message: CANCEL_BRIEF,
              }
            : { roleId, requestId: 'launch-window', title: '核实周五发布窗口', message: BRIEF }
          : {},
        searchCallId: `${callId}-search`,
        toolCallId: callId,
      })
      reply(response, events)
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const expandDelegation = async () => {
        const expandedToggle = `${TOGGLE}[aria-expanded="true"]`
        if (Number(await control.command('getElementCount', expandedToggle)) === 0) {
          await control.command('clickWhenEnabled', TOGGLE, { timeoutMs: uiTimeoutMs })
        }
        await control.command('waitFor', expandedToggle, { visible: true, timeoutMs: uiTimeoutMs })
      }
      const user = await fetchJson(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      const userId = user.id
      const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
      await waitForLogPattern(join(resultDir, 'executor.log'), /local backend registered /, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const { deviceId } = await rpc('runtime.stand_in.device_identity', {})
      const active = await rpc('runtime.stand_in.binding', {
        operation: 'bind',
        version: binding.version,
        target: { userId, deviceId, backendUrl: `${cloud.backendUrl}/api` },
      })
      assert.equal(active.status, 'active')
      assert.equal(active.target.deviceId, deviceId)
      await rpc('runtime.stand_in.onboarding.complete', {
        userId,
        weeklyReview: false,
        language: 'zh-CN',
      })
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      const original = await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: {
          ...initial,
          primary: {
            ...initial.primary,
            enabled: true,
            prompt: initial.primary?.prompt ?? '',
            preferences: initial.primary?.preferences ?? '',
          },
        },
      })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', CHAT)
      const language = await control.command('getAttribute', 'html', { value: 'lang' })
      const english = language?.startsWith('en')
      await control.command('clickWhenEnabled', testId('stand-in-create-role'))
      await control.command('waitFor', testId('stand-in-role-device'))
      await control.command('select', testId('stand-in-role-device'), { value: CLOUD_DEVICE_ID })
      await control.command('fill', testId('stand-in-role-name'), { value: '跨设备发布工程' })
      await control.command('clickWhenEnabled', testId('stand-in-save'))
      await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
      const source = await rpc('runtime.stand_in.personal.get', { userId })
      assert.deepEqual(source.roles, original.roles, 'Remote creation must preserve local roles')
      const role = source.delegationRoutes?.find(role => role.name === '跨设备发布工程')
      assert.ok(
        role,
        'The original device must retain the role address before the target goes offline'
      )
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      roleId = role.id
      const input = `${CHAT} ${testId('chat-message-input')}`
      await control.command(
        'waitFor',
        `${testId(`stand-in-overview-role-${roleId}`)}[aria-current="page"]`,
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', input, { visible: true, timeoutMs: uiTimeoutMs })
      assert.equal(await control.command('getElementCount', testId('stand-in-onboarding')), '0')
      await captureScreenshot(control, '00-remote-role-configured.png', ROOT)
      const primary = testId('stand-in-primary-open')
      await control.command('clickWhenEnabled', primary, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', `${primary}[aria-current="page"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', input, { visible: true, timeoutMs: uiTimeoutMs })
      await cloud.restartCloudExecutor({
        async beforeSpawn() {
          await control.command('fill', input, { value: REQUEST })
          await control.command('clickWhenEnabled', `${CHAT} ${testId('send-message-button')}`)
          await control.command('waitFor', CHAT, {
            text: QUEUED,
            timeoutMs: modelResponseTimeoutMs,
          })
          assert.ok(taskId)
          assert.equal(workerTurns, 0)
          await expandDelegation()
          await control.command('waitFor', `${ROW}:disabled`, {
            text: english ? 'Waiting for device' : '等待设备上线',
            timeoutMs: uiTimeoutMs,
          })
          await captureScreenshot(control, '01-role-device-offline.png', ROOT)
        },
      })
      try {
        await control.command('waitFor', `${ROW}:enabled`, {
          text: english ? 'In progress' : '进行中',
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, '02-role-running-on-assigned-device.png', ROOT)
      } finally {
        work.resolve()
      }
      await control.command('waitFor', CHAT, { text: FINAL, timeoutMs: modelResponseTimeoutMs })
      assert.equal(workerTurns, 1)
      assert.equal(deliveries, 1)
      await control.command('waitFor', `${ROW}:enabled`, {
        text: english ? 'Completed' : '已完成',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, '03-role-result-in-original-chat.png', ROOT)
      await control.command('clickWhenEnabled', ROW, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', testId('assistant-message-content'), {
        text: RESULT,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, '04-remote-role-task-open.png')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', input, { visible: true, timeoutMs: uiTimeoutMs })
      await cloud.restartCloudExecutor({
        async beforeSpawn() {
          await control.command('fill', input, { value: CANCEL_REQUEST })
          await control.command('clickWhenEnabled', `${CHAT} ${testId('send-message-button')}`)
          await control.command('waitFor', TOGGLE, {
            text: english ? 'Waiting for device' : '等待设备上线',
            timeoutMs: modelResponseTimeoutMs,
          })
          await expandDelegation()
          await control.command(
            'clickWhenEnabled',
            `${CARD} ${testId('stand-in-delegated-work-cancel-all')}`
          )
          await control.command(
            'clickWhenEnabled',
            testId('stand-in-delegated-work-confirm-cancel')
          )
          await control.command('waitFor', ROW, {
            text: english ? 'Waiting for device to confirm cancellation' : '等待设备上线确认取消',
            timeoutMs: uiTimeoutMs,
          })
          await captureScreenshot(control, '05-cancel-while-device-offline.png', ROOT)
        },
      })
      await control.command('waitFor', ROW, {
        text: english ? 'Cancelled' : '已取消',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(workerTurns, 1, 'Reconnection must not start a cancelled dispatch')
      await captureScreenshot(control, '06-cancelled-when-device-returns.png', ROOT)
      await control.command('fill', input, { value: DEPENDENCY_REQUEST })
      await control.command('clickWhenEnabled', `${CHAT} ${testId('send-message-button')}`)
      await control.command('waitFor', TOGGLE, {
        text: english ? 'A prerequisite did not complete' : '前置任务未成功',
        timeoutMs: modelResponseTimeoutMs,
      })
      await expandDelegation()
      const retry = `${CARD} ${testId('stand-in-delegated-work-retry')}`
      await control.command('waitFor', retry, { timeoutMs: uiTimeoutMs })
      assert.deepEqual(dependencyRuns, [1, 0])
      await captureScreenshot(control, '07-cross-device-prerequisite-blocked.png', ROOT)
      await control.command('clickWhenEnabled', retry)
      const readBranches = () =>
        rpc('runtime.stand_in.role_task.branches', {
          userId,
          taskId: `stand-in-chat-${userId}-primary`,
        })
      await storyUntil(
        readBranches,
        ({ items }) =>
          items.some(branch => branch.taskId === dependencies[0] && branch.status === 'done'),
        modelResponseTimeoutMs,
        'The original conversation should receive the successful prerequisite retry'
      )
      await control.command('waitFor', `${CHAT} ${testId('assistant-message-content')}`, {
        text: DEPENDENCY_FINAL,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', TOGGLE, {
        text: english ? '2 of 2 complete' : '已完成 2/2',
        timeoutMs: uiTimeoutMs,
      })
      const branches = await readBranches()
      const retried = branches.items.find(branch => branch.taskId === dependencies[0])
      assert.equal(retried.attempt, 1)
      assert.equal(retried.taskAddress.taskId, dependencies[0])
      assert.deepEqual(dependencyRuns, [2, 1])
      await expandDelegation()
      await captureScreenshot(control, '08-cross-device-prerequisite-retry-result.png', ROOT)
    },
  }
}
