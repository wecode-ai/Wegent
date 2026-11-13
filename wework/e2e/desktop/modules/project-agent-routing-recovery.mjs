import assert from 'node:assert/strict'
import { waitForBoardValue } from './collaboration-board-flows.mjs'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { verifyProjectAgentEditing } from './project-agent-editing.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`

/** A different Maintainer repairs a policy conflict without moving Issue history. */
export async function verifyProjectAgentRoutingRecovery(control, cloud, historical, options) {
  const request = async (path, { method = 'GET', body, token = cloud.authToken } = {}) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.uiTimeoutMs),
    })
    const data = await response.json()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }
  const route = new URL(JSON.parse(await control.command('snapshot')).location)
  const project = await request(`/api/v1/cloud-projects/${route.searchParams.get('projectId')}`)
  const base = `/api/v1/cloud-projects/${project.id}`
  const agents = await request(`${base}/chat-agents`)
  const original = agents.find(agent => agent.status === 'active')
  assert.ok(original, 'The template must retain an active Agent')
  const executionPolicy = original.executionPolicy ?? original.execution_policy
  const modelPolicy = original.modelPolicy ?? original.model_policy
  const originalEnvironmentId = executionPolicy.environment_id
  assert.notEqual(originalEnvironmentId, String(historical.id))
  for (const automation of await request(`${base}/automations`)) {
    if (automation.enabled)
      await request(`${base}/automations/${automation.id}`, {
        method: 'PATCH',
        body: { version: automation.version, enabled: false },
      })
  }
  await request(`/api/v1/workspaces/${project.workspace_id}/execution-environments`, {
    method: 'POST',
    body: { device_id: historical.id },
  })
  await request(`${base}/execution-environments`, {
    method: 'POST',
    body: { device_id: historical.id },
  })
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
      name: '设备策略冲突智能体',
      runtime: 'codex',
      execution_policy: { mode: 'fixed', environment_id: String(historical.id) },
      model_policy: { mode: 'user_select' },
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
    'The first real execution must establish Issue affinity',
    options.modelResponseTimeoutMs
  )
  await assign(conflict.id)
  const alert = selector('cloud-todo-save-error')
  await control.command('waitFor', alert, { text: 'ISSUE_RUNNER_CONFLICT' })
  const errorText = await control.command('getText', alert)
  for (const text of [conflict.name, originalEnvironmentId, String(historical.id), '运行设置'])
    assert.ok(errorText.includes(text), `Routing error must identify ${text}: ${errorText}`)
  await control.command('waitFor', selector('cloud-todo-state-assignee'), { text: agent.name })
  const unchanged = await request(`/api/v1/loop-items/${completed.id}`)
  assert.equal(
    unchanged.execution_id,
    completed.execution_id,
    'A denied assignment must not create work'
  )
  assert.equal(unchanged.assignee_agent_id, agent.id)
  await assign(group.id, 'group')
  await control.command('waitFor', alert, { text: group.name })
  const groupError = await control.command('getText', alert)
  for (const text of [conflict.name, originalEnvironmentId, String(historical.id)])
    assert.ok(groupError.includes(text), `Group error must identify ${text}: ${groupError}`)
  await control.command('waitFor', selector('cloud-todo-state-assignee'), { text: agent.name })
  const deniedGroup = await request(`/api/v1/loop-items/${completed.id}`)
  assert.equal(deniedGroup.execution_id, completed.execution_id)
  assert.equal(deniedGroup.assignee_agent_id, agent.id)
  assert.equal(deniedGroup.assignee_group_id, null)
  await options.captureScreenshot(control, 'project-agent-runner-conflict.png', CONTENT)
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
  await assign(conflict.id)
  await waitForBoardValue(
    async () => {
      const current = await request(`/api/v1/loop-items/${completed.id}`)
      return (
        current.assignee_agent_id === conflict.id &&
        current.execution_id !== completed.execution_id &&
        current.execution_state === 'succeeded'
      )
    },
    true,
    'Repairing the member policy must allow the same Issue to execute again',
    options.modelResponseTimeoutMs
  )
  await options.captureScreenshot(control, 'project-agent-runner-recovered.png', CONTENT)
}
