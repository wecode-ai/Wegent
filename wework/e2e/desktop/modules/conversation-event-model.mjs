import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { modelRequestTexts } from './model-tool-output.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  selectedToolCall,
  selectTool,
} from './response-protocol.mjs'

export const WORKFLOW_CONFLICT_TOPIC = 'https://github.com/org/repo/actions/runs/44231414768'

export const PREEXISTING_CHECKS_TOPIC = 'https://github.com/org/repo/pull/17'
export const PREEXISTING_CHECKS_HEAD = 'b'.repeat(40)

export function findEventFact(value, predicate) {
  if (typeof value === 'string') {
    try {
      return findEventFact(JSON.parse(value), predicate)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  if (predicate(value)) return value
  for (const child of Object.values(value)) {
    const result = findEventFact(child, predicate)
    if (result) return result
  }
  return undefined
}

/** The same model-only script drives local and Remote Docker event stories. */
export function createConversationEventModel({
  markerPrefix: MARKER,
  providerId: PROVIDER,
  onEvent = () => {},
  onQuestion = () => {},
}) {
  const sources = {}
  const completed = new Set()
  function events(body, phase) {
    const marker = `${MARKER}_${phase}`
    const workflowConflict = phase === 'workflow_conflict'
    const preexistingChecks = phase === 'preexisting_checks'
    const usesGoal = !['ordinary', 'workflow', 'workflow_conflict', 'preexisting_checks'].includes(
      phase
    )
    if (phase === 'owner' && modelRequestTexts(body).includes(`${marker}_CONTINUE`)) {
      if (!requestContainsToolOutput(body, `${marker}_complete`)) {
        return selectedToolCall(
          `${marker}_complete`,
          selectTool(body, 'update_goal', { status: 'complete' })
        )
      }
      return [assistantMessage(`${marker}_DONE`)]
    }
    if (modelRequestTexts(body).includes(`${marker}_EVENT_RECEIVED`)) {
      const eventInputs = body.input.filter(
        item =>
          item.role === 'user' && JSON.stringify(item.content).includes(`${marker}_EVENT_RECEIVED`)
      )
      const input = eventInputs.at(-1)
      assert.ok(input, 'The event must be delivered as a user message')
      const goalCompleted = requestContainsToolOutput(body, `${marker}_complete`)
      if (phase === 'human') {
        assert.equal(eventInputs.length, 1, 'The input must contain exactly one event message')
        // The request after update_goal retains the same message ID in its history.
        onEvent(input.id)
      }
      if (input.id !== undefined) {
        assert.match(input.id, /^msg/, 'Responses rejects message IDs without the msg prefix')
      }
      const text =
        typeof input.content === 'string'
          ? input.content
          : input.content.map(part => part.text ?? '').join('\n')
      const data = JSON.parse(text.slice(text.indexOf('\n{') + 1))
      assert.equal(
        data.events.length,
        1,
        'Duplicate provider events must be removed before model input'
      )
      assert.equal(
        data.events[0].topicId,
        preexistingChecks
          ? PREEXISTING_CHECKS_TOPIC
          : workflowConflict
            ? WORKFLOW_CONFLICT_TOPIC
            : 'release-document',
        'Only the selected topic may wake the model'
      )
      if (preexistingChecks) {
        const { external } = data.events[0]
        assert.equal(external.eventType, 'tracked.status')
        assert.equal(external.payload.headRefOid, PREEXISTING_CHECKS_HEAD)
        assert.equal(external.payload.statusCheckRollup.state, 'FAILURE')
        assert.ok(Date.parse(external.payload.failedAt) < Date.parse(data.sources[0].enabledAfter))
      }
      if (phase === 'workflow') {
        assert.equal(data.events[0].external.payload.id, 44231414768)
        assert.equal(data.events[0].external.payload.head_sha, 'a'.repeat(40))
        assert.equal(data.events[0].external.payload.status, 'completed')
        assert.equal(data.events[0].external.payload.conclusion, 'failure')
      }
      if (workflowConflict) {
        const { external } = data.events[0]
        assert.equal(external.eventType, 'tracked.workflow_run_pr_conflict')
        assert.equal(external.payload.id, 44231414768)
        assert.equal(external.payload.head_sha, 'a'.repeat(40))
        assert.equal(external.url, 'https://github.com/org/repo/pull/17')
      }
      if (['goal', 'human', 'resumed_goal'].includes(phase) && !goalCompleted) {
        return selectedToolCall(
          `${marker}_complete`,
          selectTool(body, 'update_goal', { status: 'complete' })
        )
      }
      completed.add(phase)
      return [assistantMessage(`${marker}_DONE：已收到文档变化，在原会话继续处理。`)]
    }
    if (
      usesGoal &&
      phase !== 'resumed_goal' &&
      !requestContainsToolOutput(body, `${marker}_create_goal`)
    ) {
      return selectedToolCall(
        `${marker}_create_goal`,
        selectTool(body, 'create_goal', {
          objective: `${marker} 等待文档变化并完成检查`,
          token_budget: 20000,
        })
      )
    }
    const steps = [
      ['providers', 'list_connection_event_providers', {}],
      [
        'resources',
        'list_connection_event_resources',
        { provider_id: PROVIDER, kind: 'record', query: '' },
      ],
      [
        'subscribe',
        'subscribe_connection_events',
        {
          subscription_key: marker,
          source: sources[phase],
          match: preexistingChecks
            ? {
                '/eventType': 'git.event',
                '/topicId': PREEXISTING_CHECKS_TOPIC,
                '/external/eventType': 'tracked.status',
                '/external/payload/headRefOid': PREEXISTING_CHECKS_HEAD,
                '/external/payload/statusCheckRollup/state': 'FAILURE',
              }
            : {
                '/eventType': workflowConflict ? 'git.event' : 'message.received',
                '/topicId': workflowConflict ? WORKFLOW_CONFLICT_TOPIC : 'release-document',
                ...(phase === 'workflow'
                  ? {
                      '/external/eventType': 'tracked.workflow_run',
                      '/external/payload/id': 44231414768,
                      '/external/payload/head_sha': 'a'.repeat(40),
                      '/external/payload/status': 'completed',
                      $any: [
                        { '/external/payload/conclusion': 'success' },
                        { '/external/payload/conclusion': 'failure' },
                      ],
                    }
                  : workflowConflict
                    ? {
                        '/external/payload/id': 44231414768,
                        '/external/payload/head_sha': 'a'.repeat(40),
                        $any: [
                          {
                            '/external/eventType': 'tracked.workflow_run',
                            '/external/payload/status': 'completed',
                          },
                          { '/external/eventType': 'tracked.workflow_run_pr_conflict' },
                        ],
                      }
                    : {}),
              },
          continuation: `${marker} 文档有变化，请继续原任务。`,
          wait_for_event: usesGoal,
        },
      ],
    ]
    if (preexistingChecks) {
      steps.splice(1, 0, [
        'provider-detail',
        'list_connection_event_providers',
        { provider_id: PROVIDER },
      ])
    }
    for (const [step, name, args] of steps) {
      const callId = `${marker}_${step}`
      if (!requestContainsToolOutput(body, callId)) {
        if (step === 'subscribe') args.source = sources[phase]
        return mcpToolRequestEvents(body, {
          toolName: 'invoke_capability',
          directToolName: 'mcp__wework_control__invoke_capability',
          argumentsValue: { name, arguments: args },
          searchCallId: `${callId}_search`,
          toolCallId: callId,
        }).events
      }
      const output = readMcpToolOutput(body, callId)
      assert.equal(
        findEventFact(output, value => value.isError === true),
        undefined,
        output
      )
      if (step === 'providers')
        assert.ok(
          findEventFact(output, value => value.items?.some(item => item.id === PROVIDER)),
          output
        )
      if (preexistingChecks && step === 'providers') {
        const catalog = findEventFact(output, value =>
          value.items?.some(item => item.id === PROVIDER)
        )
        const provider = catalog.items.find(item => item.id === PROVIDER)
        assert.deepEqual(
          Object.keys(provider).sort(),
          ['availability', 'displayName', 'id', 'resourceKinds'],
          'Default discovery must expose only provider summaries to the model'
        )
        assert.ok(
          !output.includes('connectionEventProviderCatalog'),
          'Full catalog metadata must stay out of model context'
        )
      }
      if (step === 'provider-detail') {
        const catalog = findEventFact(output, value =>
          value.items?.some(item => item.id === PROVIDER)
        )
        assert.deepEqual(
          catalog?.items.map(item => item.id),
          [PROVIDER],
          output
        )
        assert.ok(catalog.items[0].eventTypes.includes('message.received'), output)
      }
      if (step === 'resources') {
        const resources = findEventFact(output, value =>
          value.items?.some(item => item.providerId === PROVIDER)
        ).items
        sources[phase] = resources.find(
          item =>
            item.id ===
            (preexistingChecks
              ? 'preexisting-checks-record'
              : phase === 'human'
                ? 'long-archive-record'
                : 'archive-record')
        )
        assert.ok(sources[phase])
      }
      if (step === 'subscribe')
        assert.equal(
          findEventFact(output, value => value.subscription)?.subscription.status,
          'armed',
          output
        )
    }
    if (phase === 'human' && !requestContainsToolOutput(body, `${marker}_question`))
      return selectedToolCall(
        `${marker}_question`,
        selectTool(body, 'request_user_input_async', {
          questions: [{ title: '请确认是否继续处理这个事件。' }],
        })
      )
    if (phase === 'human') onQuestion(readMcpToolOutput(body, `${marker}_question`))
    return [assistantMessage(`${marker}_WAITING：已订阅发布文档变化，事件到达后会自动继续。`)]
  }

  return { events, completed, sources }
}
