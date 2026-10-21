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

export async function selectWorkspaceIssueAgent(
  control,
  triggerSelector,
  sourceId,
  timeoutMs,
  mode = 'edit'
) {
  await control.command('click', triggerSelector)
  const prefix = mode === 'create' ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'
  const option = `[data-testid="${prefix}-option-resource:${sourceId}"]`
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
  {
    contentSelector,
    projectId,
    title,
    description,
    assigneeTarget,
    assignDuringCreate = false,
    beforeSave,
    timeoutMs,
  }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-tab-board"]'), {
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: description,
  })
  const selectAssignee = async () => {
    const prefix = assignDuringCreate ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'
    await control.command('click', scoped(`[data-testid="${prefix}"]`))
    const option = `[data-testid="${prefix}-option-${assigneeTarget}"]`
    await control.command('waitFor', option, { visible: true, timeoutMs })
    await control.command('click', option)
  }
  if (assignDuringCreate) {
    await selectAssignee()
    await beforeSave?.()
  }
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  const issue = await waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === title),
    'Wework UI did not persist the Issue',
    timeoutMs
  )
  if (!assignDuringCreate) {
    await selectAssignee()
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
      timeoutMs,
    })
  }
  return issue
}

/** Revoke the real workspace grant after selection, then recover the same unsaved draft. */
export async function verifyRevokedWorkspaceIssueAgent(
  control,
  request,
  { contentSelector, project, source, title, timeoutMs }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  const agentsPath = `/api/v1/cloud-projects/${project.id}/chat-agents`
  const issuesPath = `/api/v1/cloud-projects/${project.id}/loop-items`
  const runsPath = `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
  const grantPath = `/api/v1/workspaces/${project.workspace_id}/agents`
  const before = {
    agents: (await request(agentsPath)).map(item => item.id).sort(),
    issues: (await request(issuesPath)).items.map(item => item.id).sort(),
    runs: (await request(runsPath)).items.map(item => item.id).sort(),
  }
  await request(`${grantPath}/${source.team_id}`, { method: 'DELETE' })
  try {
    assert.equal(
      (await request(grantPath)).items.some(item => item.id === source.id),
      false,
      'The real backend did not revoke the selected workspace Agent'
    )
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'))
    await control.command('waitFor', scoped('[data-testid="cloud-todo-save-error"]'), {
      text: 'Workspace Agent is no longer available',
      timeoutMs,
    })
    assert.equal(
      await control.command('getValue', scoped('[data-testid="cloud-todo-title"]')),
      title
    )
    assert.equal(
      await control.command('getAttribute', scoped('[data-testid="cloud-todo-create-assignee"]'), {
        value: 'data-value',
      }),
      `resource:${source.id}`,
      'Failed binding lost the selected resource draft'
    )
    assert.deepEqual(
      (await request(agentsPath)).map(item => item.id).sort(),
      before.agents,
      'Revocation created a project binding'
    )
    assert.deepEqual(
      (await request(issuesPath)).items.map(item => item.id).sort(),
      before.issues,
      'Failed binding created an orphan Issue'
    )
    assert.deepEqual(
      (await request(runsPath)).items.map(item => item.id).sort(),
      before.runs,
      'Failed binding started an execution'
    )
  } finally {
    const restored = await request(grantPath, {
      method: 'POST',
      body: JSON.stringify({ team_id: source.team_id }),
    })
    assert.equal(restored.id, source.id, 'Restoring authorization changed the resource identity')
  }
}

export async function assertCreatedWorkspaceIssueAgent(request, { projectId, source, issue }) {
  const agents = await request(`/api/v1/cloud-projects/${projectId}/chat-agents`)
  const bindings = agents.filter(candidate => candidate.wegentTeamId === source.team_id)
  assert.equal(
    bindings.length,
    1,
    'Recovering the create draft duplicated the project Agent binding'
  )
  assert.equal(String(issue.assignee_agent_id), String(bindings[0].id))
  assert.notEqual(String(bindings[0].id), String(source.id), 'Assignment persisted a resource ID')
  const issues = (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items
  assert.equal(
    issues.filter(candidate => candidate.title === issue.title).length,
    1,
    'Recovering the create draft duplicated the Issue'
  )
}
