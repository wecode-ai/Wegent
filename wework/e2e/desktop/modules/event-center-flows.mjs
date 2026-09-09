import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  assistantMessage,
  responseCreated,
  responseCompleted,
  responseFailed,
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
      assert.ok(
        serialized.includes('assignment_result_callback') ||
          serialized.includes('human_continue') ||
          serialized.includes('The Issue is complete. End this turn.'),
        'Coordinator decision did not acknowledge the callback handoff'
      )
      return [
        responseCreated(responseId),
        assistantMessage('已提交工单分派。'),
        responseCompleted(responseId),
      ]
    }
    const version = issue.workflow.assignment_version ?? 0
    if (!requestContainsToolOutput(payload, 'event-flow-wrong-version')) {
      assert.notEqual(issue.workflow.version, version, 'Fixture must distinguish the two versions')
      return requestTool(
        payload,
        responseId,
        'decide_issue_assignment',
        {
          decision: {
            request_id: `event-wrong-version-${issueId}-${version}`,
            expected_assignment_version: issue.workflow.version,
            action: 'complete',
            reason: 'Verify that a workflow snapshot version cannot authorize assignment',
          },
        },
        'event-flow-wrong-version'
      )
    }
    assert.ok(serialized.includes('assignment_version_conflict'), 'Missing specific conflict code')
    assert.ok(
      serialized.includes('current_assignment_version'),
      'Conflict lost the current version'
    )
    assert.ok(serialized.includes('read_issue'), 'Conflict did not require re-reading the Issue')
    if (!requestContainsToolOutput(payload, 'event-flow-reread')) {
      return requestTool(payload, responseId, 'get_board_item', {}, 'event-flow-reread')
    }
    const roleCompleted =
      issue.workflow.assignment?.node_id === 'role_1' &&
      issue.workflow.assignment.status === 'completed' &&
      issue.workflow.assignment.execution_status === 'succeeded'
    const humanCompleted =
      issue.workflow.assignment?.assignee_user_id != null &&
      issue.workflow.assignment.status === 'completed'
    if (issue.workflow.assignment?.execution_status === 'failed') {
      assert.ok(serialized.includes('交办结果 callback'), 'Failure did not resume through callback')
      assert.ok(serialized.includes('CALLBACK_WORKER_FAILED'), 'Failure callback lost the error')
    }
    return requestTool(
      payload,
      responseId,
      'decide_issue_assignment',
      {
        decision: {
          request_id: `event-flow-${issueId}-${version}`,
          expected_assignment_version: version,
          action: humanCompleted ? 'complete' : roleCompleted ? 'assign_user' : 'assign_role',
          ...(humanCompleted
            ? {}
            : roleCompleted
              ? { assignee_user_id: Number(issue.created_by_user_id) }
              : { node_id: 'role_1' }),
          instruction: roleCompleted
            ? 'Review the result and decide when to continue. You may start multiple tasks first.'
            : 'Verify the requested acceptance result',
          reason: ['failed', 'cancelled'].includes(issue.workflow.assignment?.execution_status)
            ? 'CALLBACK_REASSIGNMENT'
            : 'CALLBACK_INITIAL_ASSIGNMENT',
        },
      },
      'event-flow-decide'
    )
  }
  if (serialized.includes('Read the Issue and verify its requested result.')) {
    const issueId = serialized.match(/task_id: ([A-Za-z0-9_-]+)/)?.[1]
    const issue = await request(`/api/v1/loop-items/${issueId}`)
    if (issue.workflow.assignment_version === 2) {
      // Hold this real worker turn so the user can stop it from its conversation.
      await new Promise(resolve => setTimeout(resolve, 45000))
    }
    if (issue.workflow.assignment?.decision.reason === 'CALLBACK_INITIAL_ASSIGNMENT') {
      const failure = responseFailed(responseId, 'CALLBACK_WORKER_FAILED')
      failure.response.error.code = 'invalid_request_error'
      return [responseCreated(responseId), failure]
    }
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
  const initialAssignment = await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => Boolean(issue.workflow.assignment),
    'Generated coordinator did not assign work',
    timeoutMs
  )
  const initialVersion = initialAssignment.workflow.assignment_version
  await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.assignment?.execution_status === 'failed',
    'Worker failure did not persist for the coordinator callback',
    timeoutMs
  )
  await captureScreenshot(control, 'event-center-callback-worker-failed.png')
  const reassigned = await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.assignment_version === initialVersion + 1,
    'Failure callback did not start a new coordinator turn and reassign work',
    timeoutMs
  )
  const stoppedExecution = await waitForValue(
    async () => {
      const executions = await request(`${base}/executions`)
      return executions.items.find(
        execution =>
          String(execution.automationRunId) ===
          String(reassigned.workflow.assignment.automation_run_id)
      )
    },
    execution => execution?.status === 'running' && Boolean(execution.runtimeTaskId),
    'Reassigned worker did not start before the conversation stop',
    timeoutMs
  )
  const bindings = await request(`/api/v1/loop-items/${issueId}/tasks`)
  const binding = bindings.find(task => task.task_id === stoppedExecution.runtimeTaskId)
  assert.ok(binding, 'Running worker has no task conversation binding')
  await control.command('click', '[data-testid="event-center-open-issue"]', { visible: true })
  await control.command('click', '[data-testid="cloud-todo-workflow-node-role_1"]', {
    visible: true,
  })
  const taskSelector = `[data-testid="cloud-todo-open-workflow-task-role_1-${binding.id}"]`
  await control.command('scrollIntoView', taskSelector)
  await control.command('click', taskSelector, { visible: true })
  await control.command('waitFor', '[data-testid="pause-response-button"]', { visible: true })
  await captureScreenshot(control, 'event-center-conversation-before-stop.png')
  await control.command('click', '[data-testid="pause-response-button"]', { visible: true })
  const stopped = await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.assignment?.execution_status === 'cancelled',
    'User stop did not persist its cancelled result',
    timeoutMs
  )
  assert.equal(stopped.workflow.orchestration_status, 'paused', 'User stop restarted AI assignment')
  assert.equal(stopped.workflow.assignment_version, initialVersion + 1)
  await captureScreenshot(control, 'event-center-user-stopped.png')
  const executionCount = (await request(`${base}/executions`)).total
  // Observe a full queue claim window: neither a retry nor a coordinator may start.
  await new Promise(resolve => setTimeout(resolve, 35000))
  assert.equal((await request(`${base}/executions`)).total, executionCount)
  assert.equal(
    (await request(`/api/v1/loop-items/${issueId}`)).workflow.orchestration_status,
    'paused'
  )
  await control.command('click', '[data-testid^="workbench-close-pane-"]', { visible: true })
  await control.command('click', '[data-testid="cloud-todo-detail-close"]', { visible: true })
  await request(`/api/v1/loop-items/${issueId}/workflow-plan/resume`, { method: 'POST' })
  await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.assignment_version === initialVersion + 2,
    'Explicit resume did not restart assignment',
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
    issue => issue.workflow.orchestration_status === 'waiting_human',
    'Coordinator did not hand control to the responsible person',
    timeoutMs
  )
  const rules = await request(`${base}/automations`)
  assert.equal(rules.length, 0, 'Issue-specific workflow leaked into reusable automations')
  const generatedIssue = await request(`/api/v1/loop-items/${issueId}`)
  assert.equal(generatedIssue.workflow.ai_automation_rule_id, null)
  assert.equal(generatedIssue.workflow.nodes[0].name, '结果核对')
  assert.equal(generatedIssue.workflow.assignment_version, initialVersion + 3)
  assert.equal(generatedIssue.workflow.assignment.status, 'waiting_human')
  const assertHumanControl = async (
    expectedVersion = generatedIssue.workflow.assignment_version
  ) => {
    const current = await request(`/api/v1/loop-items/${issueId}`)
    assert.equal(current.workflow.orchestration_status, 'waiting_human')
    assert.equal(current.workflow.assignment.id, generatedIssue.workflow.assignment.id)
    assert.equal(current.workflow.assignment_version, expectedVersion)
  }
  const personalTasks = []
  for (let index = 0; index < 2; index++) {
    const task = await request('/api/runtime-work/create', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: runtimeProfile.executionDeviceId,
        standaloneChatWorkspace: true,
        runtime: 'codex',
        message: `HUMAN_CONTROL_REVIEW_${index}: Help me review this result; I will decide when to continue.`,
        title: `人工核对任务 ${index + 1}`,
        modelId: runtimeProfile.model,
        modelType: runtimeProfile.modelType,
        modelOptions: runtimeProfile.modelOptions,
        cloudProjectId: String(project.id),
      }),
    })
    assert.equal(task.accepted, true, task.error)
    personalTasks.push(task)
    await request(`/api/v1/loop-items/${issueId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: task.deviceId, taskId: task.taskId }),
    })
    await assertHumanControl()
  }
  await waitForValue(
    () => request('/api/runtime-work'),
    work => {
      const tasks = [
        ...(work.projects ?? []).flatMap(value => value.deviceWorkspaces ?? []),
        ...(work.chats ?? []),
      ].flatMap(value => value.tasks ?? [])
      return personalTasks.every(created =>
        tasks.some(
          task => task.taskId === created.taskId && task.turnStatus === 'completed' && !task.running
        )
      )
    },
    'Both tasks started by the responsible person must actually finish',
    timeoutMs
  )
  await assertHumanControl()
  await captureScreenshot(control, 'event-center-02-created-flow.png')
  const reference = {
    provider: 'generic',
    external_id: 'https://example.invalid/events/acceptance',
    url: 'https://example.invalid/events/acceptance',
  }
  const hook = await request(`${base}/incoming-hooks`, {
    method: 'POST',
    body: JSON.stringify({
      name: '验收外部事件',
      sourceType: 'generic',
      collectionMode: 'webhook',
      resource: { resourceType: 'endpoint', url: reference.url },
    }),
  })
  const hookPath = new URL(hook.webhookUrl).pathname
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
  assert.equal(duplicate.eventId, receipt.eventId)
  await waitForValue(
    () => request(`${base}/events`),
    events =>
      events.some(
        event =>
          event.id === receipt.eventId && event.status === 'routed' && event.issue_id === issueId
      ),
    'Existing artifact did not route back to the same Issue',
    timeoutMs
  )
  items = await request(`${base}/loop-items`)
  assert.equal(items.items.length, 1, 'Related review created a duplicate Issue')
  await control.command('navigate', 'body', { value: '/todo' })
  await control.command('click', `[data-testid="cloud-sidebar-project-${project.id}"]`, {
    visible: true,
  })
  await control.command('click', '[data-testid="cloud-project-events-view"]', { visible: true })
  await control.command('waitFor', `[data-testid="event-center-event-${receipt.eventId}"]`, {
    visible: true,
  })
  await control.command('click', `[data-testid="event-center-event-${receipt.eventId}"]`, {
    visible: true,
  })
  await control.command('waitFor', '[data-testid="event-center-open-issue"]', { visible: true })
  await captureScreenshot(control, 'event-center-03-existing-issue.png')
  // Incoming context invalidates stale decisions without releasing human control.
  const eventVersion = generatedIssue.workflow.assignment_version + 1
  await assertHumanControl(eventVersion)
  await control.command('click', '[data-testid="event-center-open-issue"]', { visible: true })
  await control.command('waitFor', '[data-testid="issue-assignment-human-control"]')
  await control.command('scrollIntoView', '[data-testid="issue-assignment-human-control"]')
  await control.command('waitFor', '[data-testid="issue-assignment-submit-result"]', {
    text: '继续推进',
    visible: true,
  })
  await control.command('fill', '[data-testid="issue-assignment-result"]', {
    value: 'I reviewed both tasks and the incoming event. Proceed with the approved result.',
  })
  await assertHumanControl(eventVersion)
  await captureScreenshot(control, 'event-center-human-controls-advancement.png')
  await control.command('click', '[data-testid="issue-assignment-submit-result"]', {
    visible: true,
  })
  const completed = await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}`),
    issue => issue.workflow.orchestration_status === 'completed',
    'Explicit Continue did not return the human result to AI',
    timeoutMs
  )
  assert.equal(completed.workflow.assignment_version, eventVersion + 1)
  assert.equal(completed.workflow.nodes[0].status, 'completed')
  await control.command('waitFor', '[data-testid="issue-assignment-completion"]', {
    text: '已满足工单要求',
    visible: true,
  })
  await captureScreenshot(control, 'event-center-human-continued.png')
  const config = await request(`${base}/event-center`)
  await request(`${base}/event-center`, {
    method: 'PUT',
    body: JSON.stringify({ ...config, enabled: false }),
  })
}
