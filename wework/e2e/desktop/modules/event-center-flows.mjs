import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  assistantMessage,
  responseCreated,
  responseCompleted,
  requestContainsToolOutput,
  mcpToolRequestEvents,
  selectMcpTool,
  namespacedFunctionCall,
} from './response-protocol.mjs'

function requestTool(payload, responseId, name, args, id) {
  const searchId = `${id}-search`
  if (requestContainsToolOutput(payload, searchId)) {
    const tool = selectMcpTool(payload, 'wework_space', name, args)
    return [
      responseCreated(responseId),
      ...namespacedFunctionCall(id, tool.namespace, tool.name, tool.arguments),
      responseCompleted(responseId),
    ]
  }
  const advertised = new Set((payload.tools ?? []).map(tool => tool.name ?? tool.function?.name))
  const directToolName = [`wework_space__${name}`, `wegent-wework-space_${name}`].find(value =>
    advertised.has(value)
  )
  const selection = mcpToolRequestEvents(payload, {
    toolName: name,
    argumentsValue: args,
    directToolName,
    searchCallId: searchId,
    toolCallId: id,
  })
  return [responseCreated(responseId), ...selection.events, responseCompleted(responseId)]
}

export async function eventCenterModelResponse(payload, responseId, request) {
  const serialized = JSON.stringify(payload)
  if (serialized.includes("this board's event-center router")) {
    const projectId = serialized.match(/project_id: ([A-Za-z0-9_-]+)/)?.[1]
    const eventId = serialized.match(/event_id: ([A-Za-z0-9_-]+)/)?.[1]
    assert.ok(projectId && eventId, 'Event router identity is missing from the Runtime prompt')
    const events = await request(`/api/v1/cloud-projects/${projectId}/events`)
    const event = events.find(value => value.id === eventId)
    assert.ok(event, 'Runtime event was not durably stored')
    if (requestContainsToolOutput(payload, 'event-center-decide')) {
      return [
        responseCreated(responseId),
        assistantMessage('事件已交办。'),
        responseCompleted(responseId),
      ]
    }
    const context = await request(`/api/v1/cloud-projects/${projectId}/events/${eventId}/context`, {
      headers: { 'X-Event-Execution-Id': String(event.execution_id) },
    })
    let decision
    if (context.related_issue) {
      decision = {
        action: 'route_existing',
        issue_id: context.related_issue.id,
        reason: 'External artifact belongs to the existing Issue',
      }
    } else if (
      !event.history.some(entry => entry.role === 'user') &&
      event.title.includes('澄清')
    ) {
      decision = {
        action: 'clarify',
        question: '请明确希望得到什么结果？',
        reason: 'The outcome is unclear',
      }
    } else if (context.automations.length) {
      decision = {
        action: 'start_workflow',
        automation_id: context.automations[0].id,
        goal: 'Verify the event center acceptance result',
        reason: 'Reuse an existing suitable experience',
      }
    } else {
      decision = {
        action: 'create_workflow',
        goal: 'Verify the event center acceptance result',
        reason: 'No suitable experience exists',
        workflow: {
          name: '事件中心验收经验',
          description: 'Verify a concrete acceptance result',
          coordinator_prompt:
            'EVENT_CENTER_FLOW_E2E: Assign the verification role, then confirm the goal.',
          roles: [
            { name: '结果核对', instruction: 'Read the Issue and verify its requested result.' },
          ],
        },
      }
    }
    if (requestContainsToolOutput(payload, 'event-center-context')) {
      return requestTool(
        payload,
        responseId,
        'decide_event',
        { decision: { version: event.version, ...decision } },
        'event-center-decide'
      )
    }
    return requestTool(payload, responseId, 'get_event_context', {}, 'event-center-context')
  }
  if (serialized.includes('EVENT_CENTER_FLOW_E2E') && serialized.includes('你像领导一样负责分活')) {
    const issueId = serialized.match(/task_id: ([A-Za-z0-9_-]+)/)?.[1]
    const issue = await request(`/api/v1/loop-items/${issueId}`)
    if (requestContainsToolOutput(payload, 'event-flow-decide')) {
      return [
        responseCreated(responseId),
        assistantMessage('已提交工单分派。'),
        responseCompleted(responseId),
      ]
    }
    const version = issue.workflow.assignment_version ?? 0
    const roleCompleted =
      issue.workflow.assignment?.node_id === 'role_1' &&
      issue.workflow.assignment.status === 'completed'
    return requestTool(
      payload,
      responseId,
      'decide_issue_assignment',
      {
        decision: {
          request_id: `event-flow-${issueId}-${version}`,
          expected_version: version,
          action: roleCompleted ? 'complete' : 'assign_role',
          ...(roleCompleted ? {} : { node_id: 'role_1' }),
          instruction: 'Verify the requested acceptance result',
          reason: 'Advance according to the goal and latest result',
        },
      },
      'event-flow-decide'
    )
  }
  if (serialized.includes('Read the Issue and verify its requested result.')) {
    if (requestContainsToolOutput(payload, 'event-role-reference')) {
      return [
        responseCreated(responseId),
        assistantMessage('已核对结果并登记外部事项。'),
        responseCompleted(responseId),
      ]
    }
    return requestTool(
      payload,
      responseId,
      'register_external_reference',
      {
        reference: {
          provider: 'generic',
          external_id: 'https://example.invalid/events/acceptance',
          url: 'https://example.invalid/events/acceptance',
        },
      },
      'event-role-reference'
    )
  }
  return null
}

export async function verifyEventCenter({
  control,
  request,
  runtimeProfile,
  captureScreenshot,
  waitForValue,
  timeoutMs,
}) {
  const project = await request('/api/v1/cloud-projects', {
    method: 'POST',
    body: JSON.stringify({ project_key: 'EVTC', name: '事件中心真实验收' }),
  })
  const base = `/api/v1/cloud-projects/${project.id}`
  await request(`${base}/event-center`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, runtime_profile_id: runtimeProfile.id, version: 1 }),
  })
  await control.command('navigate', 'body', { value: '/todo' })
  const previousClient = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await control.awaitReadyAfter(previousClient)
  await control.command('waitFor', `[data-testid="cloud-sidebar-project-${project.id}"]`, {
    visible: true,
  })
  await control.command('click', `[data-testid="cloud-sidebar-project-${project.id}"]`, {
    visible: true,
  })
  await control.command('waitFor', '[data-testid="cloud-project-events-view"]', { visible: true })
  await control.command('click', '[data-testid="cloud-project-events-view"]', { visible: true })
  await control.command('fill', '[data-testid="event-center-submit-content"]', {
    value: '澄清：处理这批资料',
    visible: true,
  })
  await control.command('click', '[data-testid="event-center-submit"]', { visible: true })
  await control.command('waitFor', '[data-testid="event-center-reply-content"]', {
    visible: true,
    timeoutMs,
  })
  let items = await request(`${base}/loop-items`)
  assert.equal(items.items.length, 0, 'Clarification created an Issue prematurely')
  await captureScreenshot(control, 'event-center-01-clarification.png')
  await control.command('fill', '[data-testid="event-center-reply-content"]', {
    value: '核对结果并给出结论',
    visible: true,
  })
  await control.command('click', '[data-testid="event-center-reply"]', { visible: true })
  const routed = await waitForValue(
    () => request(`${base}/events`),
    events => events[0]?.status === 'routed',
    'Event did not reach the flow AI',
    timeoutMs
  )
  const issueId = routed[0].issue_id
  // Each Runtime turn has its own queue claim window: coordinator, role, then coordinator.
  await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => Boolean(issue.workflow.assignment),
    'Generated coordinator did not assign work',
    timeoutMs
  )
  await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.assignment?.status === 'completed',
    'Assigned role did not return a result',
    timeoutMs
  )
  await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.orchestration_status === 'completed',
    'Generated flow did not complete through real Runtime',
    timeoutMs
  )
  const rules = await request(`${base}/automations`)
  assert.equal(rules.length, 0, 'Issue-specific workflow leaked into reusable automations')
  const generatedIssue = await request(`/api/v1/loop-items/${issueId}`)
  assert.equal(generatedIssue.workflow.ai_automation_rule_id, null)
  assert.equal(generatedIssue.workflow.nodes[0].name, '结果核对')
  await captureScreenshot(control, 'event-center-02-created-flow.png')
  const reference = {
    provider: 'generic',
    external_id: 'https://example.invalid/events/acceptance',
    url: 'https://example.invalid/events/acceptance',
  }
  const hook = await request(`${base}/incoming-hooks`, {
    method: 'POST',
    body: JSON.stringify({ name: '验收外部事件' }),
  })
  const hookPath = new URL(hook.webhook_url).pathname
  const deliveryId = randomUUID()
  const payload = {
    title: '有新的核对意见',
    description: '请结合新意见继续处理',
    url: reference.url,
  }
  const send = () =>
    request(hookPath, {
      method: 'POST',
      headers: { 'Idempotency-Key': deliveryId },
      body: JSON.stringify(payload),
    })
  const receipt = await send()
  const duplicate = await send()
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.event_id, receipt.event_id)
  await waitForValue(
    () => request(`${base}/events`),
    events =>
      events.some(
        event =>
          event.id === receipt.event_id && event.status === 'routed' && event.issue_id === issueId
      ),
    'Existing artifact did not route back to the same Issue',
    timeoutMs
  )
  items = await request(`${base}/loop-items`)
  assert.equal(items.items.length, 1, 'Related review created a duplicate Issue')
  await control.command('waitFor', `[data-testid="event-center-event-${receipt.event_id}"]`, {
    visible: true,
  })
  await control.command('click', `[data-testid="event-center-event-${receipt.event_id}"]`, {
    visible: true,
  })
  await control.command('waitFor', '[data-testid="event-center-open-issue"]', { visible: true })
  await captureScreenshot(control, 'event-center-03-existing-issue.png')
  const config = await request(`${base}/event-center`)
  await request(`${base}/event-center`, {
    method: 'PUT',
    body: JSON.stringify({ ...config, enabled: false }),
  })
}
