import { openStandInExamples } from './stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { readStoryTaskEvidence } from './stand-in-private-story-evidence.mjs'
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
import {
  STORY_CHAT,
  STORY_PRIMARY,
  STORY_USER,
  assertStoryPrimaryOutcome,
  openStoryPrimary,
  storyUntil,
} from './stand-in-source-story-evidence.mjs'

const RECORD = 'MEETING_MATERIALS_SOURCE'
const WORK = 'MEETING_PREPARATION_READ_ORIGINAL'
const TITLE = '发布评审会原始材料'
const REQUEST = '整理下一场会议的背景、待确认问题和相关资料，标出信息冲突。'
const RESULT = '发布评审会：导出功能已完成，回滚负责人仍需确认。'
const MATERIALS = `${RECORD}
会议名称：发布评审会
背景：导出功能已完成，等待上线评审。
日历摘录：明天14:00–15:00。
会议通知：明天14:30–15:30。
待确认：回滚负责人尚未确定。
资料：导出功能验收记录已附在本会话。
这是两条尚未统一的原始记录，请保留差异。`

/** Verify material-backed delivery; this does not simulate an external calendar provider. */
export function createMeetingUserStory(options) {
  let active = false
  let sourceTaskId
  let workerTaskId
  let sourceRead = false
  const reports = new Set()
  const rpc = (control, method, params) => options.rpc(control, method, params)
  const has = requestContainsToolOutput
  const output = (body, id) => JSON.parse(readMcpToolOutput(body, id))
  const call = (body, id, toolName, argumentsValue) =>
    mcpToolRequestEvents(body, {
      toolName,
      directToolName: `mcp__wework_stand_in__${toolName}`,
      argumentsValue,
      searchCallId: `${id}-search`,
      toolCallId: id,
    }).events

  function prepare(body) {
    if (!has(body, 'meeting-story-discover'))
      return call(body, 'meeting-story-discover', 'list_tasks', { limit: 50 })
    const sources = output(body, 'meeting-story-discover')
    assert.ok(sources.items.some(item => item.taskId === sourceTaskId && item.title === TITLE))
    if (!has(body, 'meeting-story-delegate'))
      return call(body, 'meeting-story-delegate', 'create_task', {
        requestId: 'meeting-materials-outcome-story',
        title: '发布评审会会前简报',
        message: `${WORK}\n读取原材料会话 ${sourceTaskId}，整理背景、时间冲突与待确认事项，并把具体简报返回原会话。`,
      })
    const created = output(body, 'meeting-story-delegate')
    assert.equal(created.success, true)
    workerTaskId = created.taskId
    return [assistantMessage('正在核对会议原始材料，简报完成后会直接在这里告诉你。')]
  }

  function readMaterials(body) {
    if (!has(body, 'meeting-story-materials'))
      return call(body, 'meeting-story-materials', 'read_task', { taskId: sourceTaskId, limit: 10 })
    const history = output(body, 'meeting-story-materials')
    assert.equal(history.success, true)
    assert.equal(history.taskId, sourceTaskId)
    const record = history.messages.find(
      item => item.role === 'user' && item.content?.includes(RECORD)
    )
    assert.ok(record, 'Read actual owner-provided material through the native history boundary')
    assert.notEqual(record.contentComplete, false, 'Do not summarize incomplete source material')
    for (const fact of ['导出功能已完成', '14:00–15:00', '14:30–15:30', '回滚负责人尚未确定'])
      assert.ok(record.content.includes(fact), `The real record must support ${fact}`)
    sourceRead = true
    return [
      assistantMessage(
        `${RESULT}\n时间有冲突：原日历摘录为明天14:00–15:00，会议通知为14:30–15:30，需要组织者确认。\n会前先确认准确时间和回滚负责人，再核对导出功能验收记录。\n原始资料：《${history.title ?? TITLE}》，会话 ${sourceTaskId}。`
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
      let events = delegatedTaskResultEvents(body)
      if (events) {
        const receipt = text.match(
          /^Wework delegated task result: resultId=([^,\s]+), taskId=([^,\s]+), status=done,/
        )
        if (receipt?.[2] === workerTaskId && JSON.stringify(events).includes(RESULT))
          reports.add(receipt[1])
      } else if (text.includes(RECORD)) events = [assistantMessage('会议原始材料已记录。')]
      else if (text.includes(WORK)) events = readMaterials(body)
      else if (text.includes(REQUEST)) events = prepare(body)
      else if (text.startsWith('Review this silent intake batch')) {
        if (!has(body, 'meeting-story-intake'))
          events = call(body, 'meeting-story-intake', 'read_intake', {})
        else if (!has(body, 'meeting-story-ignore'))
          events = call(body, 'meeting-story-ignore', 'ignore_events', {
            eventIds: output(body, 'meeting-story-intake').snapshot.events.map(item => item.id),
            reason: '本场景的会前资料由原用户请求处理，没有其他需要重复执行的事项。',
          })
        else events = [assistantMessage('本批状态已核对。')]
      } else return false
      const id = `meeting-story-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, model) {
      active = true
      sourceTaskId = `meeting-materials-${process.pid}`
      try {
        const created = await rpc(control, 'runtime.tasks.create', {
          taskId: sourceTaskId,
          title: TITLE,
          message: MATERIALS,
          workspacePath: options.workspacePath,
          modelSelection: {
            modelName: model.local_model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: model.provider },
          },
          executionRequest: {
            task_id: sourceTaskId,
            subtask_id: 'meeting-materials',
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Meeting materials' }],
            model_config: { model_id: model.local_model_id, model_provider: model.provider },
            user_id: STORY_USER,
            prompt: MATERIALS,
          },
        })
        assert.equal(created.success, true)
        await storyUntil(
          () => rpc(control, 'runtime.tasks.get', { taskId: sourceTaskId }),
          value => value.task?.status === 'done',
          options.modelResponseTimeoutMs,
          'Record real meeting material'
        )
        await openStoryPrimary(control)
        await openStandInExamples(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-onboarding-example-meeting_prep"]'
        )
        const draft = await control.command(
          'getText',
          `${STORY_CHAT} [data-testid="chat-message-input"]`
        )
        assert.equal(
          draft.trim(),
          REQUEST,
          'Use the ordinary example without adding QA instructions'
        )
        await control.command(
          'clickWhenEnabled',
          `${STORY_CHAT} [data-testid="send-message-button"]`
        )
        const transcript = await assertStoryPrimaryOutcome(
          control,
          (method, params) => rpc(control, method, params),
          RESULT,
          options.modelResponseTimeoutMs
        )
        assert.ok(sourceRead && workerTaskId, 'Actual material reading must precede final delivery')
        const answer = transcript.messages.find(
          item => item.role === 'assistant' && item.content?.includes(RESULT)
        )
        for (const value of [
          sourceTaskId,
          workerTaskId,
          '14:00–15:00',
          '14:30–15:30',
          '回滚负责人',
        ])
          assert.ok(answer.content.includes(value), `The primary outcome must contain ${value}`)
        const worker = await rpc(control, 'runtime.tasks.get', { taskId: workerTaskId })
        assert.equal(worker.task.status, 'done')
        const evidence = await storyUntil(
          () => readStoryTaskEvidence(options.executorHome, workerTaskId),
          value => Boolean(value?.receipt),
          options.modelResponseTimeoutMs,
          'Read the actual private outbox receipt without exposing it through the public task API'
        )
        const completion = evidence.completion
        assert.equal(completion.status, 'done')
        assert.equal(completion.turnId, evidence.lastTurnId)
        assert.equal(completion.turnId, worker.task.runtimeHandle.lastTurnId)
        assert.equal(
          completion.generation.delegation.sourceTaskId,
          STORY_PRIMARY,
          'A delegated task must return to its captured original primary conversation'
        )
        const receipt = evidence.receipt
        assert.ok(receipt)
        assert.deepEqual(
          [...reports],
          [receipt],
          'Read and report the exact native completion once'
        )
        await options.captureScreenshot(
          control,
          'story-meeting-source-backed-result-in-primary.png'
        )
      } finally {
        active = false
        for (const taskId of [workerTaskId, sourceTaskId].filter(Boolean)) {
          const archived = await rpc(control, 'runtime.tasks.archive', { taskId })
          assert.equal(archived.accepted, true)
        }
      }
    },
  }
}
