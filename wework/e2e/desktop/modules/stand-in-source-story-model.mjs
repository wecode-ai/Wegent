import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
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

export const storyToolOutput = (body, id) => JSON.parse(readMcpToolOutput(body, id))
const has = requestContainsToolOutput
const call = (body, id, name, args) =>
  mcpToolRequestEvents(body, {
    toolName: name,
    directToolName: `mcp__wework_stand_in__${name}`,
    argumentsValue: args,
    searchCallId: `${id}-search`,
    toolCallId: id,
  }).events

function latestUserText(body) {
  if (typeof body.input === 'string') return body.input
  const message = (Array.isArray(body.input) ? body.input : [])
    .filter(item => item.role === 'user')
    .at(-1)
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map(part => part.text ?? '').join('')
}

/** Script model decisions only; all tools, source reads, receipts and result wakes are native. */
export function createSourceStoryModel({ marker, roleId, providerId, mode, expected }) {
  const state = {
    marker,
    active: false,
    phase: 1,
    round: 0,
    taskId: null,
    continuous: false,
    nativeCancellationRequested: false,
    reads: [],
    replies: [],
    continuations: [],
    proposalSubmitted: false,
  }

  function trace(event, detail) {
    console.log(
      '[source-story-model]',
      JSON.stringify({ marker, event, phase: state.phase, round: state.round, ...detail })
    )
  }

  function coordinator(body) {
    const prefix = `${marker}-intake-${state.round}`
    const read = `${prefix}-read`,
      action = `${prefix}-act`
    if (has(body, action)) {
      const result = storyToolOutput(body, action)
      trace('action-accepted', { callId: action, actionId: result.id, status: result.status })
      assert.equal(result.status, 'pending')
      state.round++
      return [assistantMessage('已按当前来源和授权处理这批变化。')]
    }
    if (!has(body, read)) return call(body, read, 'read_intake', {})
    const snapshot = storyToolOutput(body, read).snapshot
    assert.ok(Array.isArray(snapshot.events))
    trace('intake-read', {
      callId: read,
      eventIds: snapshot.events.map(item => item.id),
      workTaskIds: snapshot.works?.map(item => item.taskId),
      originalTaskId: state.taskId,
    })
    const event = snapshot.events.find(
      item =>
        item.kind === 'connection' &&
        item.roleIds?.includes(roleId) &&
        JSON.stringify(item).includes(marker)
    )
    if (!event)
      return call(body, action, 'ignore_events', {
        eventIds: snapshot.events.map(item => item.id),
        reason: '本批没有尚需处理的新来源变化。',
      })
    if (mode === 'project' && state.taskId) {
      assert.ok(
        snapshot.works.some(work => work.taskId === state.taskId),
        'The current immutable intake must authorize the original work'
      )
      const metadata = `${prefix}-metadata`,
        history = `${prefix}-history`
      if (!has(body, metadata)) return call(body, metadata, 'read_work', { taskId: state.taskId })
      assert.ok(storyToolOutput(body, metadata))
      if (!has(body, history)) return call(body, history, 'read_task', { taskId: state.taskId })
      const previous = storyToolOutput(body, history)
      assert.equal(previous.taskId, state.taskId)
      assert.ok(
        previous.messages.some(
          message => message.role === 'assistant' && message.content?.includes(expected(1).fact)
        ),
        'Read the actual earlier outcome before continuing'
      )
      state.continuations.push({ taskId: state.taskId, eventId: event.id })
      trace('continue-work', { callId: action, eventId: event.id, taskId: state.taskId })
      return call(body, action, 'continue_work', {
        eventIds: [event.id],
        taskId: state.taskId,
        message: `${marker}: 核实新变化，继续原来的跟进并把具体结论告诉我。`,
      })
    }
    trace('create-work', { callId: action, eventId: event.id, roleId })
    return call(body, action, 'create_work', {
      eventIds: [event.id],
      roleId,
      title: `${marker} 来源工作`,
    })
  }

  function worker(body) {
    const phase = state.phase
    const value = expected(phase)
    const read = `${marker}-work-${phase}`,
      payload = `${read}-payload`,
      reply = `${read}-reply`
    if (has(body, reply)) {
      assert.ok(
        state.reads.some(item => item.phase === phase),
        "Reply reporting requires this phase's complete original-source read"
      )
      if (phase === 2 && mode === 'reply') {
        assert.equal(
          state.nativeCancellationRequested,
          true,
          'The verifier must actually request native cancellation'
        )
        assert.ok(readMcpToolOutput(body, reply))
        return [assistantMessage('本次回复已取消，未发送。')]
      }
      const receipt = storyToolOutput(body, reply)
      assert.equal(
        receipt.success,
        true,
        'The external protocol must actually accept the native reply'
      )
      assert.ok(receipt.result?.openMessageId)
      state.replies.push({ phase, receipt: receipt.result.openMessageId })
      return [assistantMessage(value.fact)]
    }
    if (!has(body, read)) return call(body, read, 'read_work', {})
    const work = storyToolOutput(body, read)
    assert.ok(work.work?.taskId, 'Worker must read its actual bound work')
    trace('worker-bound', {
      callId: read,
      taskId: work.work.taskId,
      originalTaskId: state.taskId,
      continuationTaskIds: state.continuations.map(item => item.taskId),
    })
    if (mode === 'project' && state.taskId) assert.equal(work.work.taskId, state.taskId)
    if (mode === 'project') state.taskId = work.work.taskId
    const message = work.messages.find(item => item.text === value.text)
    assert.ok(message, "The real collected event must contain this phase's source facts")
    assert.ok(message.recordId, 'Full source reads require the immutable version record ID')
    if (
      mode === 'project' &&
      phase > 1 &&
      !state.continuations.some(item => item.taskId === work.work.taskId)
    ) {
      // Native exact-record routing can continue a revision without an AI assessment.
      state.continuations.push({
        taskId: work.work.taskId,
        recordId: message.recordId,
        route: 'native-record-binding',
      })
    }
    if (!has(body, payload))
      return call(body, payload, 'read_work', {
        messageId: message.recordId,
        payloadOffset: 0,
      })
    const original = storyToolOutput(body, payload)
    assert.equal(original.nextOffset, null, 'This small source fixture must be read completely')
    const complete = JSON.parse(original.payload)
    assert.equal(complete.recordId, message.recordId)
    assert.equal(complete.text, value.text)
    if (mode === 'project') assert.equal(complete.version, value.version)
    else assert.equal(complete.id, value.messageId)
    if (!state.reads.some(item => item.phase === phase))
      state.reads.push({
        phase,
        taskId: work.work.taskId,
        recordId: message.recordId,
        messageId: message.id,
      })
    if (mode === 'project') return [assistantMessage(value.fact)]
    if (value.imageResourceId) {
      const images = `${read}-images`
      if (!has(body, images))
        return call(body, images, 'read_source', { query: { includeImages: true } })
      const history = storyToolOutput(body, images)
      assert.equal(history.readOnly, true)
      assert.ok(
        history.items.some(item =>
          item.images?.some(
            image => image.resourceId === value.imageResourceId && image.path.endsWith('.png')
          )
        ),
        'Read the actual image through the source-bound tool before asking to send'
      )
    }
    return call(body, reply, 'reply', {
      messageId: message.recordId,
      text: value.reply,
      ...(value.mentionOpenDingTalkIds
        ? { mentionOpenDingTalkIds: value.mentionOpenDingTalkIds }
        : {}),
    })
  }

  function proposal(body) {
    const profile = `${marker}-profile`,
      propose = `${marker}-proposal`
    if (!has(body, profile)) return call(body, profile, 'get_profile', {})
    if (has(body, propose)) {
      assert.ok(storyToolOutput(body, propose).id, 'The native profile proposal must be persisted')
      state.proposalSubmitted = true
      return [assistantMessage('已拟好持续回复授权，请确认这个来源的变更。')]
    }
    const settings = structuredClone(storyToolOutput(body, profile))
    const role = settings.roles.find(item => item.id === roleId)
    assert.ok(role)
    const source = role.connections.find(item => item.providerId === providerId)
    assert.equal(source.policy.askBeforeAct, true)
    source.policy.askBeforeAct = false
    return call(body, propose, 'propose_profile', {
      summary: '只对已选来源持续授权回复，保留其他连接及其权限。',
      settings,
    })
  }

  return Object.assign(state, {
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
      const latest = latestUserText(body)
      let events = delegatedTaskResultEvents(body)
      if (!events) {
        if (latest.startsWith('Review this silent intake batch')) events = coordinator(body)
        else if (latest.includes(`${marker}-CONTINUOUS`)) events = proposal(body)
        else if (latest.includes(`${marker}-OWNER`))
          events = [assistantMessage('我会关注已选来源的新变化，并把具体结果告诉你。')]
        else if (JSON.stringify(body.input ?? []).includes(marker)) events = worker(body)
        else return false
      }
      const id = `${marker}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    reviewApproval() {
      return {
        risk_level: 'low',
        user_authorization: state.continuous ? 'high' : 'low',
        outcome: state.continuous || mode === 'project' ? 'allow' : 'deny',
        rationale: "Use only this story's bound source and confirmed permissions.",
      }
    },
  })
}
