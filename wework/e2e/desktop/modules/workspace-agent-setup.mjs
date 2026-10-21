import assert from 'node:assert/strict'

import {
  inCollaborationSidebar,
  openDirectProjectCreation,
  openProjectAgentCreator,
  selectCloudAgentModel,
} from './workspace-flows.mjs'

export async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export async function createWorkspaceAndProject(
  control,
  request,
  { contentSelector, workspaceName, projectName, timeoutMs }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
  await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
    value: workspaceName,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-workspace-create-confirm"]'),
    { timeoutMs }
  )
  const workspace = await waitForValue(
    async () => (await request('/api/v1/workspaces')).items,
    items => items?.find(item => item.name === workspaceName),
    'Wework UI did not persist the workspace',
    timeoutMs
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-workspace-project-create"]'),
    {
      visible: true,
      timeoutMs,
    }
  )
  await openDirectProjectCreation(control, contentSelector)
  await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
    value: projectName,
  })
  await control.command('click', scoped('[data-testid="collaboration-project-create-advanced"]'))
  await control.command('click', scoped('[data-testid="cloud-project-task-provider-local"]'))
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-project-create-confirm"]'),
    { timeoutMs }
  )
  const project = await waitForValue(
    async () => (await request(`/api/v1/workspaces/${workspace.id}/projects`)).items,
    items => items?.find(item => item.name === projectName),
    'Wework UI did not persist the project',
    timeoutMs
  )
  await control.command('waitFor', scoped('[data-testid="collaboration-project-create-confirm"]'), {
    visible: false,
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), { timeoutMs })
  return project
}

export async function openWorkspaceAgentConfiguration(control, contentSelector, workspaceId) {
  const scoped = selector => `${contentSelector} ${selector}`
  const sidebar = selector => inCollaborationSidebar(selector, contentSelector)
  const workspaceTree = sidebar(`[data-testid="collaboration-workspace-tree-${workspaceId}"]`)
  await control.command('hover', `${workspaceTree} .collaboration-workspace-row`)
  await control.command(
    'clickWhenEnabled',
    `${workspaceTree} [data-testid="collaboration-workspace-actions"]`
  )
  await control.command('clickWhenEnabled', '[data-testid="collaboration-workspace-nav-settings"]')
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-workspace-nav-participants"]')
  )
}

export async function createSharedWorkspaceAgent(
  control,
  request,
  { contentSelector, project, name, model, environmentId, systemPrompt, timeoutMs }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  const sidebar = selector => inCollaborationSidebar(selector, contentSelector)
  await openWorkspaceAgentConfiguration(control, contentSelector, project.workspace_id)
  await openProjectAgentCreator(
    control,
    scoped('[data-testid="project-agent-add"]'),
    timeoutMs,
    'wework-agent-resource-creator'
  )
  await control.command('fill', '[data-testid="wework-agent-display-name"]', { value: name })
  await selectCloudAgentModel(control, request, model, timeoutMs, environmentId)
  await control.command('fill', '[data-testid="wework-agent-system-prompt"]', {
    value: systemPrompt,
  })
  await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
    timeoutMs,
  })
  const source = await waitForValue(
    async () => (await request(`/api/v1/workspaces/${project.workspace_id}/agents`)).items,
    agents => agents.find(agent => agent.name === name),
    'The workspace catalog did not expose the Agent display name',
    timeoutMs
  )
  await control.command('waitFor', scoped(`[data-testid="project-agent-row-${source.team_id}"]`), {
    text: name,
    timeoutMs,
  })
  assert.equal(
    (await request(`/api/v1/cloud-projects/${project.id}/chat-agents`)).some(
      agent => agent.wegentTeamId === source.team_id
    ),
    false,
    'Creating a workspace Agent must not implicitly install it in a project'
  )
  await control.command(
    'clickWhenEnabled',
    sidebar(`[data-testid="collaboration-workspace-project-${project.id}"]`)
  )
  return source
}

export async function selectWorkspaceIssueAgent(control, triggerSelector, sourceId, timeoutMs) {
  await control.command('click', triggerSelector)
  const option = `[data-testid="cloud-todo-detail-assignee-option-resource:${sourceId}"]`
  await control.command('waitFor', option, { visible: true, timeoutMs })
  await control.command('click', option)
  await control.command('waitFor', `${triggerSelector}[data-value="resource:${sourceId}"]`, {
    visible: true,
    timeoutMs,
  })
}

export async function createAndAssignCloudIssue(
  control,
  request,
  { contentSelector, projectId, title, description, assigneeTarget, timeoutMs }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: description,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  const issue = await waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === title),
    'Wework UI did not persist the Issue',
    timeoutMs
  )
  const trigger = scoped('[data-testid="cloud-todo-detail-assignee"]')
  await control.command('click', trigger)
  const option = `[data-testid="cloud-todo-detail-assignee-option-${assigneeTarget}"]`
  await control.command('waitFor', option, { visible: true, timeoutMs })
  await control.command('click', option)
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  return issue
}
