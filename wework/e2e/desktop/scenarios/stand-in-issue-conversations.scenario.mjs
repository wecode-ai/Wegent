import assert from 'node:assert/strict'
import { setTimeout as poll } from 'node:timers/promises'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'

const MARKER = `ISSUE_ROOM_${process.pid}`
const ACK = '收到，我会让子代理检查，完成后在这里回复。'
const RESULT = '检查已完成，结果已核实。'
const FOLLOWUP = '补充解释已完成，仍在同一个分身会话中。'
const SUPPLEMENT = '补充信息已收到，会话历史保持连续。'
const RAW_CHILD = 'ISSUE_ROOM_PRIVATE_CHILD_TRACE'
const ROLE = 'issue-room-reviewer'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'

/** Real comments, inbox, Runtime and native subagents; only the model is scripted. */
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  let cloud, user, project, settings, environment, heldChild
  let spawned = false
  let waited = false
  let delivered = false
  let childReleased = false
  let supplementHandled = false
  let waitCount = 0
  let waitCallId
  let childId
  const waitOutputs = []
  const messageVisibility = []
  const reply = (response, events) => {
    const id = `${MARKER}-${Date.now()}`
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  async function until(load, accept, description, timeout = modelResponseTimeoutMs) {
    const deadline = Date.now() + timeout
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (accept(latest)) return latest
      await poll(100)
    }
    assert.fail(`${description}: ${JSON.stringify(latest)}`)
  }
  const comments = issue =>
    request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`)
  const mention = () => [{ type: 'user', id: String(user.id), label: user.user_name }]
  async function revealMessage(control, activity, id) {
    const selector = `${activity} [data-testid="cloud-task-activity-message-${id}"]`
    await control.command('scrollIntoViewAsUser', selector)
    const metrics = await until(
      async () =>
        JSON.parse(await control.command('getElementMetrics', selector, { value: 'includeText' })),
      rows => rows[0]?.hitTestVisible && rows[0].visibleIntersection?.height >= rows[0].height - 1,
      'The public message must actually be visible before evidence capture',
      uiTimeoutMs
    )
    messageVisibility.push(metrics[0])
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', { name: MARKER })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: '分身 Issue 对话验收',
        task_provider: 'local',
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      if (isCollaborationSubagentRequest(req.headers)) {
        heldChild = response
        return true
      }
      if (!JSON.stringify(body.input).includes(MARKER)) return false
      if (!spawned) {
        spawned = true
        const acknowledgment = assistantMessage(ACK)
        acknowledgment.item.phase = 'commentary'
        reply(response, [
          acknowledgment,
          ...selectedToolCall(
            'issue-room-spawn',
            selectTool(body, 'spawn_agent', {
              task_name: 'issue_room_worker',
              message: `Perform the bounded test check and return ${RAW_CHILD}. Do not publish comments.`,
              fork_turns: 'none',
            })
          ),
        ])
      } else if (!waited) {
        const spawnOutput = toolOutputText(body, 'issue-room-spawn')
        childId = JSON.parse(spawnOutput).agent_id
        assert.ok(childId, `The parent must receive a real native child identity: ${spawnOutput}`)
        waited = true
        waitCallId = `issue-room-wait-${++waitCount}`
        reply(
          response,
          selectedToolCall(
            waitCallId,
            selectTool(body, 'wait_agent', { targets: [childId], timeout_ms: 60000 })
          )
        )
      } else if (!delivered) {
        const output = toolOutputText(body, waitCallId)
        assert.ok(output, 'Each wait must return through a real native tool call')
        waitOutputs.push(output)
        const waitedResult = JSON.parse(output)
        const statuses = Object.values(waitedResult.status)
        assert.ok(
          !statuses.some(status => status.errored || status === 'not_found'),
          `Native child execution failed: ${output}`
        )
        const childReport = statuses.some(status => status.completed === RAW_CHILD)
        if (!childReport) {
          assert.equal(
            waitedResult.timed_out,
            true,
            `Native wait returned no completed child: ${output}`
          )
          waitCallId = `issue-room-wait-${++waitCount}`
          reply(
            response,
            selectedToolCall(
              waitCallId,
              selectTool(body, 'wait_agent', { targets: [childId], timeout_ms: 60000 })
            )
          )
          return true
        }
        assert.ok(childReleased, 'A result cannot be published before the child finishes')
        delivered = true
        reply(response, [assistantMessage(RESULT)])
      } else if (!supplementHandled) {
        supplementHandled = true
        reply(response, [assistantMessage(SUPPLEMENT)])
      } else {
        reply(response, [assistantMessage(FOLLOWUP)])
      }
      return true
    },
    async verify(control) {
      const appDevice = await environment.waitForConnectedAppDevice()
      const rpc = (method, values) => requestExecutor(control, method, values, uiTimeoutMs)
      const create = title =>
        request(`/v1/cloud-projects/${project.id}/loop-items`, {
          title,
          tags: ['room'],
          notify_assignee: false,
        })
      // Concurrent real MySQL transactions must not allocate duplicate recipient cursors.
      const concurrent = await Promise.all(
        ['并发评论一', '并发评论二'].map(title =>
          request(`/v1/cloud-projects/${project.id}/loop-items`, {
            title,
            tags: ['not-handled'],
            notify_assignee: false,
          })
        )
      )
      const inputs = await Promise.all(
        concurrent.map(issue =>
          request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`, {
            body: '只验证消息投递',
            mentions: mention(),
          })
        )
      )
      const feed = await request('/v1/stand-in-issue-events?after=0')
      const observed = feed.events.filter(event =>
        inputs.some(input => input.id === event.payload.commentId)
      )
      assert.equal(observed.length, 2)
      assert.equal(new Set(observed.map(event => event.sequence)).size, 2)
      const otherDevice = (await environment.devices()).find(
        device => device.device_type === 'cloud' && device.device_id !== appDevice.device_id
      )
      assert.ok(otherDevice, 'The real cloud fixture must expose a second owned device')
      const reserve = device =>
        fetch(`${cloud.backendUrl}/api/v1/loop-items/${concurrent[0].id}/tasks`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            deviceId: device.device_id,
            taskId: `${MARKER}-reserved`,
            standInConversationId: `${MARKER}-conversation`,
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
      const reservations = await Promise.all([appDevice, otherDevice].map(reserve))
      const reservationResults = await Promise.all(
        reservations.map(async response => ({
          status: response.status,
          body: await response.text(),
        }))
      )
      assert.deepEqual(
        reservationResults.map(result => result.status).sort(),
        [201, 409],
        `Exactly one real device may reserve an Issue conversation: ${JSON.stringify(reservationResults)}`
      )
      const reservedBindings = await request(`/v1/loop-items/${concurrent[0].id}/tasks`)
      assert.equal(reservedBindings.length, 1)
      assert.equal(reservedBindings[0].stand_in_conversation_id, `${MARKER}-conversation`)
      const initial = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      settings = await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: {
          ...initial,
          roles: [
            ...initial.roles,
            {
              ...initial.roles[0],
              id: ROLE,
              name: '项目检查分身',
              enabled: true,
              prompt: MARKER,
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: String(project.id), store: 'cloud' }],
                excludedProjects: [],
                tags: ['room'],
                policy: { automatic: true, askBeforeAct: false, immediate: true },
              },
            },
          ],
        },
      })
      const issue = await create(`${MARKER}：同一事项持续协作`)
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      const activity = `${ACTIVE} [data-testid="cloud-task-activity-${issue.id}"]`
      const form = `${activity} [data-testid="task-comment-form"]`
      const editor = `${form} [data-testid="cloud-task-activity-composer"]`
      await control.command('waitFor', editor)
      await control.command('fill', editor, {
        value: `[$@${user.user_name}](wework-member://${user.id}) ${MARKER} 请启动子代理检查，完成后告诉我结果。`,
      })
      const dismiss = '[data-testid="task-comment-form-assignee-dismiss"]'
      if (Number(await control.command('getElementCount', dismiss)) > 0)
        await control.command('click', dismiss)
      await captureScreenshot(control, 'issue-room-01-self-mention.png')
      await control.command('clickWhenEnabled', `${form} [data-testid="send-message-button"]`)
      const accepted = await until(
        () => comments(issue),
        rows => rows.some(row => row.body === ACK),
        'The Issue did not receive the public acknowledgment'
      )
      const acknowledgment = accepted.find(row => row.body === ACK)
      await control.command('waitFor', activity, { text: ACK })
      await revealMessage(control, activity, acknowledgment.id)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${activity} [data-testid="cloud-task-activity-execution-badge-${acknowledgment.id}"]`
          )
        ),
        0,
        'A delivered acknowledgment is not a completed execution'
      )
      await captureScreenshot(control, 'issue-room-02-acknowledged.png')
      assert.equal(
        (await request(`/v1/loop-items/${issue.id}`)).assignee_user_id,
        issue.assignee_user_id,
        'Mentioning myself must not change the Issue assignment'
      )
      const notices = await request('/v1/wework-notifications')
      assert.ok(
        !notices.items.some(
          notice => notice.kind === 'mention' && notice.payload.itemId === issue.id
        ),
        'Self mentions must not create a human reminder'
      )
      await until(async () => Boolean(heldChild), Boolean, 'The native child did not start')
      // The shared composer remains usable while the real native child is in flight.
      await control.command(
        'click',
        `${activity} [data-testid="cloud-task-activity-reply-toggle-${acknowledgment.id}"]`
      )
      await control.command('waitFor', '[data-testid="issue-reply-composer"]')
      await control.command('fill', editor, { value: '补充信息：只检查，不要执行外部操作。' })
      await control.command(
        'waitFor',
        `${form} [data-testid="send-message-button"]:not([disabled])`
      )
      await captureScreenshot(control, 'issue-room-03-child-running-composer-ready.png')
      await control.command('clickWhenEnabled', `${form} [data-testid="send-message-button"]`)
      await until(
        () => comments(issue),
        rows => rows.some(row => row.body.includes('补充信息：只检查')),
        'A follow-up must persist while the child is still running'
      )
      assert.ok(
        heldChild && !childReleased,
        'The child must still be running when the follow-up is accepted'
      )
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
      const observedRead = await request(`/v1/loop-items/${issue.id}/read`, {})
      assert.equal((await request(`/v1/loop-items/${issue.id}`)).is_unread, false)
      childReleased = true
      reply(heldChild, [assistantMessage(RAW_CHILD)])
      heldChild = null
      const completed = await until(
        () => comments(issue),
        rows => rows.some(row => row.body === RESULT),
        'The verified result did not return as a second comment'
      )
      assert.equal(completed.filter(row => row.body === ACK).length, 1)
      assert.equal(completed.filter(row => row.body === RESULT).length, 1)
      assert.ok(
        completed.find(row => row.body === RESULT).sequence_number > acknowledgment.sequence_number
      )
      assert.ok(
        !JSON.stringify(completed).includes(RAW_CHILD),
        'Raw child output must remain private'
      )
      const delayedRead = await request(`/v1/loop-items/${issue.id}/read`, {
        content_revision: observedRead.content_revision,
        activity_sequence: observedRead.activity_read_sequence ?? 0,
      })
      assert.equal(
        delayedRead.is_unread,
        true,
        'A delayed read may acknowledge only observed content'
      )
      assert.equal(
        (await request(`/v1/loop-items/${issue.id}`)).is_unread,
        true,
        'A public stand-in result must make an already-read Issue unread again'
      )
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      await control.command('waitFor', activity, { text: RESULT })
      await revealMessage(control, activity, completed.find(row => row.body === RESULT).id)
      await captureScreenshot(control, 'issue-room-04-result-separate-message.png')
      const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
      assert.equal(bindings.length, 1)
      const taskId = bindings[0].task_id
      const first = await until(
        () => rpc('runtime.tasks.get', { taskId }),
        value => value.task?.status === 'done' && value.task.running !== true,
        'The Issue conversation did not settle'
      )
      await until(
        () => comments(issue),
        rows => rows.some(row => row.body === SUPPLEMENT),
        'The queued follow-up was not handled after child completion'
      )
      await until(
        () => rpc('runtime.tasks.get', { taskId }),
        value => value.task?.status === 'done' && value.task.running !== true,
        'The follow-up did not settle'
      )
      assert.ok(first.task.threadId, 'The first conversation must have a real native thread')
      await control.command(
        'click',
        `${activity} [data-testid="cloud-task-activity-reply-toggle-${completed.find(row => row.body === RESULT).id}"]`
      )
      await control.command('fill', editor, { value: '请补充解释，不需要再 @。' })
      await control.command('clickWhenEnabled', `${form} [data-testid="send-message-button"]`)
      await until(
        () => comments(issue),
        rows => rows.some(row => row.body === FOLLOWUP),
        'Reply without another @ did not continue the stand-in'
      )
      await control.command('waitFor', activity, { text: FOLLOWUP })
      const finalRows = await comments(issue)
      await revealMessage(control, activity, finalRows.find(row => row.body === FOLLOWUP).id)
      await captureScreenshot(control, 'issue-room-05-reply-without-mention.png')
      const after = await until(
        () => rpc('runtime.tasks.get', { taskId }),
        value => value.task?.status === 'done' && value.task.running !== true,
        'The final reply must settle before fixture cleanup'
      )
      assert.equal(
        after.task.threadId,
        first.task.threadId,
        'A follow-up must retain native history'
      )
      assert.equal((await request(`/v1/loop-items/${issue.id}/tasks`)).length, 1)
      settings = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: { ...settings, roles: settings.roles.filter(role => role.id !== ROLE) },
      })
    },
    cleanup() {
      heldChild?.destroy()
      heldChild = null
    },
    diagnostics() {
      return {
        projectId: project?.id,
        spawned,
        waited,
        delivered,
        childReleased,
        waitOutputs,
        messageVisibility,
      }
    },
  }
}
