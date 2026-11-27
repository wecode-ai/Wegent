import assert from 'node:assert/strict'
import { waitForBoardValue } from './collaboration-board-flows.mjs'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { verifyProjectAgentEditing } from './project-agent-editing.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`

/** Failed assignments require explicit recovery; successful and live work keep their binding. */
export async function verifyProjectAgentRoutingRecovery(
  control,
  cloud,
  targetDevice,
  environment,
  options
) {
  const request = async (path, { method = 'GET', body, token = cloud.authToken } = {}) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.uiTimeoutMs),
    })
    const data = response.status === 204 ? null : await response.json()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }
  const route = new URL(JSON.parse(await control.command('snapshot')).location)
  const project = await request(`/api/v1/cloud-projects/${route.searchParams.get('projectId')}`)
  const base = `/api/v1/cloud-projects/${project.id}`
  const boundEnvironment = async issueId => {
    const rows = await environment.queryDatabase(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.runner_binding.environment_id')) AS environment_id
       FROM loop_items WHERE id = %s AND cloud_project_id = %s AND resource_type = 'task'`,
      [issueId, project.id]
    )
    assert.equal(rows.length, 1, 'The recovery Issue must retain one persisted task row')
    assert.equal(
      typeof rows[0].environment_id,
      'string',
      'The Issue must retain its runner binding'
    )
    return rows[0].environment_id
  }
  const agents = await request(`${base}/chat-agents`)
  const original = agents.find(agent => agent.status === 'active')
  assert.ok(original, 'The template must retain an active Agent')
  const executionPolicy = original.executionPolicy ?? original.execution_policy
  const modelPolicy = original.modelPolicy ?? original.model_policy
  const originalEnvironmentId = executionPolicy.environment_id
  assert.notEqual(originalEnvironmentId, String(targetDevice.id))
  for (const automation of await request(`${base}/automations`)) {
    if (automation.enabled)
      await request(`${base}/automations/${automation.id}`, {
        method: 'PATCH',
        body: { version: automation.version, enabled: false },
      })
  }
  await request(`/api/v1/workspaces/${project.workspace_id}/execution-environments`, {
    method: 'POST',
    body: { device_id: targetDevice.id },
  })
  await request(`${base}/execution-environments`, {
    method: 'POST',
    body: { device_id: targetDevice.id },
  })
  const environments = await request(
    `/api/v1/resources/execution-environments?project_id=${project.id}`
  )
  const target = environments.find(row => row.id === String(targetDevice.id))
  const targetModel = target?.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(targetModel, 'The target device must declare its actual default Codex model')
  const targetModelPolicy = {
    mode: 'fixed',
    model: {
      runtime: targetModel.runtime,
      provider: targetModel.provider,
      model_id: targetModel.model_id,
      source: targetModel.source,
    },
  }
  const password = `project-agent-peer-${process.pid}`
  const peer = await request('/api/admin/users', {
    method: 'POST',
    body: { user_name: password, password, role: 'user', auth_source: 'password' },
  })
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { user_name: password, password },
  })
  await request(`/api/v1/workspaces/${project.workspace_id}/members`, {
    method: 'POST',
    body: { user_id: peer.id, role: 'Maintainer' },
  })
  let agent = await request(`${base}/chat-agents`, {
    method: 'POST',
    token: login.access_token,
    body: {
      name: '另一位成员创建的项目智能体',
      runtime: 'codex',
      execution_policy: executionPolicy,
      model_policy: modelPolicy,
      execution_mode: 'auto',
      system_prompt: 'Return the requested result without tools.',
    },
  })
  assert.notEqual(agent.createdByUserId ?? agent.created_by_user_id, project.current_user_id)
  await reloadMainWindow(control, 'The project must reload after another member adds an Agent')
  await selectCollaborationProjectView(control, CONTENT, 'manage')
  await control.command('click', selector('collaboration-project-settings-agents'))
  await control.command('waitFor', selector(`project-agent-row-${agent.id}`), { text: agent.name })
  await verifyProjectAgentEditing(control, CONTENT, project, agent, request)
  agent = (await request(`${base}/chat-agents?include_archived=true`)).find(
    row => row.id === agent.id
  )
  agent = await request(`${base}/chat-agents/${agent.id}`, {
    method: 'PATCH',
    body: { version: agent.version, status: 'active' },
  })
  const conflict = await request(`${base}/chat-agents`, {
    method: 'POST',
    token: login.access_token,
    body: {
      name: '跨设备研发智能体',
      runtime: 'codex',
      execution_policy: { mode: 'fixed', environment_id: String(targetDevice.id) },
      model_policy: targetModelPolicy,
      execution_mode: 'auto',
      system_prompt: 'Return the requested result without tools.',
    },
  })
  const group = await request(`${base}/collaboration-groups`, {
    method: 'POST',
    body: {
      name: '复现分配错误的研发小组',
      leader: { kind: 'agent', id: agent.id, name: agent.name },
      members: [
        { kind: 'agent', id: agent.id, name: agent.name },
        { kind: 'agent', id: conflict.id, name: conflict.name },
      ],
    },
  })
  await reloadMainWindow(control, 'The project must reload after routing fixtures are created')
  await selectCollaborationProjectView(control, CONTENT, 'board')
  await control.command('clickWhenEnabled', selector('collaboration-issue-create'))
  await control.command('fill', selector('cloud-todo-title'), { value: '复现设备冲突并修复分配' })
  await control.command('clickWhenEnabled', selector('cloud-todo-create-confirm'))
  await control.command('waitFor', selector('collaboration-issue-detail'), {
    text: '复现设备冲突并修复分配',
  })
  const assign = async (id, kind = 'agent') => {
    await control.command('click', selector('cloud-todo-detail-assignee'))
    await control.command('fill', '[data-testid="cloud-todo-detail-assignee-search"]', {
      value: kind === 'group' ? group.name : id === agent.id ? agent.name : conflict.name,
    })
    await control.command(
      'clickWhenEnabled',
      `[data-testid="cloud-todo-detail-assignee-option-${kind}:${id}"]`
    )
  }
  await assign(agent.id)
  let completed
  await waitForBoardValue(
    async () => {
      const { items } = await request(`${base}/loop-items`)
      completed = items.find(row => row.title === '复现设备冲突并修复分配')
      return completed?.execution_state
    },
    'succeeded',
    'The first real execution must record its device',
    options.modelResponseTimeoutMs
  )
  const confirmRecovery = async () => {
    await control.command('waitFor', '[data-testid="runner-selection-recovery"]')
    await control.command('clickWhenEnabled', '[data-testid="runner-selection-confirm"]')
    await control.command('waitFor', '[data-testid="runner-selection-dialog"]', { visible: false })
  }
  await assign(conflict.id)
  await control.command('waitFor', '[data-testid="runner-selection-recovery"]')
  const beforeRecovery = await request('/api/v1/loop-items/' + completed.id)
  assert.equal(beforeRecovery.execution_id, completed.execution_id)
  assert.equal(beforeRecovery.assignee_agent_id, agent.id)
  assert.equal(await boundEnvironment(completed.id), originalEnvironmentId)
  await options.captureScreenshot(control, 'project-agent-runner-conflict.png', CONTENT)
  await control.command('click', '[data-testid="runner-selection-cancel"]')
  await control.command('waitFor', '[data-testid="runner-selection-dialog"]', { visible: false })
  await control.command('waitFor', selector('cloud-todo-state-assignee'), { text: agent.name })
  assert.equal(await boundEnvironment(completed.id), originalEnvironmentId)
  await assign(conflict.id)
  await confirmRecovery()
  let reassigned
  await waitForBoardValue(
    async () => {
      reassigned = await request('/api/v1/loop-items/' + completed.id)
      return (
        reassigned.assignee_agent_id === conflict.id &&
        reassigned.execution_id !== completed.execution_id &&
        reassigned.execution_state === 'queued'
      )
    },
    true,
    'Reassignment to an authorized offline device must queue successfully',
    options.uiTimeoutMs
  )
  assert.equal(await boundEnvironment(completed.id), originalEnvironmentId)
  await environment.resumeRemoteDockerExecutor()
  await waitForBoardValue(
    async () => {
      reassigned = await request('/api/v1/loop-items/' + completed.id)
      return (
        reassigned.execution_state === 'succeeded' &&
        (await boundEnvironment(completed.id)) === String(targetDevice.id)
      )
    },
    true,
    'The new device must claim and complete the reassigned Issue',
    options.modelResponseTimeoutMs
  )
  const history = await request(base + '/executions?include_terminal=true')
  const oldExecution = history.items.find(row => row.id === completed.execution_id)
  const movedExecution = history.items.find(row => row.id === reassigned.execution_id)
  assert.ok(oldExecution && movedExecution)
  for (const execution of [oldExecution, movedExecution]) {
    assert.ok(execution.runtimeDeviceId, 'Every completed run must retain its Runtime device')
    assert.ok(execution.runtimeTaskId, 'Every completed run must retain its original session')
  }
  assert.notEqual(oldExecution.runtimeDeviceId, movedExecution.runtimeDeviceId)
  assert.notEqual(oldExecution.runtimeTaskId, movedExecution.runtimeTaskId)
  assert.equal(oldExecution.status, 'completed')
  await options.captureScreenshot(control, 'project-agent-runner-reassigned.png', CONTENT)
  await control.command('click', selector('cloud-todo-detail-close'))
  await selectCollaborationProjectView(control, CONTENT, 'manage')
  await control.command('click', selector('collaboration-project-settings-agents'))
  await control.command('clickWhenEnabled', selector(`project-agent-edit-${conflict.id}`))
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]')
  await waitForBoardValue(
    () => control.command('getValue', '[data-testid="cloud-project-chat-agent-display-name"]'),
    conflict.name,
    'The conflicting Agent definition must finish loading before repair',
    options.uiTimeoutMs
  )
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-runtime-summary"]')
  await control.command('click', '[data-testid="cloud-project-chat-agent-environment"]')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="cloud-project-chat-agent-environment-option-${originalEnvironmentId}"]`
  )
  const repairedModel = JSON.stringify([
    modelPolicy.model.runtime,
    modelPolicy.model.provider,
    modelPolicy.model.model_id,
  ])
  await control.command('select', '[data-testid="cloud-project-chat-agent-model"]', {
    value: repairedModel,
    includeOptionsOnError: true,
  })
  await waitForBoardValue(
    () => control.command('getValue', '[data-testid="cloud-project-chat-agent-model"]'),
    repairedModel,
    'The repaired environment must select its valid native model',
    options.uiTimeoutMs
  )
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]')
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
  })
  const repaired = (await request(`${base}/chat-agents`)).find(row => row.id === conflict.id)
  assert.equal(
    (repaired.executionPolicy ?? repaired.execution_policy).environment_id,
    originalEnvironmentId
  )
  await selectCollaborationProjectView(control, CONTENT, 'board')
  await control.command('clickWhenEnabled', selector(`cloud-todo-card-${completed.id}`))
  // Selecting an existing recipient is idempotent; remove its completed assignment first.
  const assignments = await request(`/api/v1/loop-items/${completed.id}/assignments`)
  const previousAssignment = assignments.items.find(
    row => row.target_type === 'agent' && row.target_id === conflict.id
  )
  assert.ok(previousAssignment, 'The completed assignment must remain in the active assignment set')
  await request(`/api/v1/loop-items/${completed.id}/assignments/${previousAssignment.id}`, {
    method: 'DELETE',
  })
  await control.command('waitFor', selector('cloud-todo-state-assignee'), { text: agent.name })
  assert.equal(await boundEnvironment(completed.id), String(targetDevice.id))
  await assign(conflict.id)
  await confirmRecovery()
  await waitForBoardValue(
    async () => {
      const current = await request(`/api/v1/loop-items/${completed.id}`)
      return (
        current.assignee_agent_id === conflict.id &&
        current.execution_id !== reassigned.execution_id &&
        current.execution_state === 'succeeded'
      )
    },
    true,
    'Changing the Agent policy must allow reassignment back to the first device',
    options.modelResponseTimeoutMs
  )
  assert.equal(await boundEnvironment(completed.id), originalEnvironmentId)
  await options.captureScreenshot(control, 'project-agent-runner-recovered.png', CONTENT)
  await request(`${base}/chat-agents/${conflict.id}`, {
    method: 'PATCH',
    body: {
      version: repaired.version,
      execution_policy: { mode: 'fixed', environment_id: String(targetDevice.id) },
      model_policy: targetModelPolicy,
    },
  })
  await assign(group.id, 'group')
  await waitForBoardValue(
    async () => String((await request(`/api/v1/loop-items/${completed.id}`)).assignee_group_id),
    String(group.id),
    'The manager must accept the group assignment independently of other members’ devices',
    options.uiTimeoutMs
  )
}
