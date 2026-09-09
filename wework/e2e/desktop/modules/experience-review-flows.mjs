import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function prepareExperienceReviewFixture(backendUrl, token) {
  const request = async (path, body, auth = token, method = 'POST') => {
    const response = await fetch(`${backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.ok(response.ok, `${method} ${path} failed with ${response.status}`)
    return response.json()
  }
  const actor = await request('/api/users/me', null, token, 'GET')
  const password = randomUUID()
  const owner = await request('/api/users', {
    user_name: `experience-owner-${process.pid}`,
    password,
  })
  const login = await request('/api/auth/login', { user_name: owner.user_name, password })
  const ownerToken = login.access_token
  const project = await request(
    '/api/v1/cloud-projects',
    {
      project_key: 'VIEW',
      name: '经验审阅与权限验证',
      visibility: 'private',
    },
    ownerToken
  )
  const projectPath = `/api/v1/cloud-projects/${project.id}`
  await request(`${projectPath}/members`, { user_id: actor.id, role: 'Reporter' }, ownerToken)
  const node = {
    id: 'review',
    name: '人工验收',
    prompt: '检查工单目标与交付结果。',
    execution_mode: 'human',
    assignee_user_id: owner.id,
    depends_on: [],
    workspace_policy: 'none',
  }
  const rule = await request(
    `${projectPath}/automations`,
    {
      name: '上线前验收经验',
      prompt: node.prompt,
      enabled: false,
      triggerType: 'event',
      eventType: 'task.created',
      assignmentMode: 'manual',
      roleSource: 'generic',
      runtimeSource: 'runtime_user',
      runtimeUserId: owner.id,
      eventConfig: {
        tags: [],
        runtime_workflow_definition: {
          version: 1,
          stage_mode: 'dag',
          advancement_policy: 'manual',
          nodes: [node],
        },
        wework_flow: {
          version: 3,
          advancement: 'sequential',
          coordinator: null,
          graph: {
            nodes: [
              {
                id: node.id,
                name: node.name,
                prompt: node.prompt,
                executionMode: 'manual',
                assigneeUserId: owner.id,
                dependencies: [],
                dependencyContext: {},
                deliverables: [],
                model: '',
                environment: '',
                plugins: [],
                projectPlugins: [],
                workspacePolicy: 'none',
                x: 440,
                y: 226,
              },
            ],
          },
        },
      },
    },
    ownerToken
  )
  const forbidden = await fetch(`${backendUrl}${projectPath}/automations/${rule.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: rule.version, enabled: true }),
  })
  assert.equal(forbidden.status, 403, 'Reporter was allowed to modify the experience')
  return { project, rule }
}

export async function verifyExperienceReview(control, fixture, captureScreenshot) {
  const { project, rule } = fixture
  const readyCount = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await control.awaitReadyAfter(readyCount)
  await control.command('waitFor', `[data-testid="cloud-sidebar-project-${project.id}"]`, {
    visible: true,
  })
  await control.command('click', `[data-testid="cloud-sidebar-project-${project.id}"]`, {
    visible: true,
  })
  await control.command('click', '[data-testid="cloud-project-automation-view"]', { visible: true })
  await control.command('waitFor', `[data-testid="automation-card-${rule.id}"]`, { visible: true })
  for (const id of ['automation-create-rule', 'automation-create-blank', 'open-template-store']) {
    assert.equal(
      Number(await control.command('getElementCount', `[data-testid="${id}"]:disabled`)),
      1
    )
  }
  await captureScreenshot(control, 'experience-permission-01-view-only-home.png', 'body')
  await control.command('click', `[data-testid="automation-card-${rule.id}"]`, { visible: true })
  await control.command('waitFor', '[data-testid="automation-read-only"]', {
    text: '只读',
    visible: true,
  })
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="automation-editor-name"]:disabled')
    ),
    1
  )
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="automation-advancement-ai"]:disabled')
    ),
    1
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        '[data-testid="automation-node-insert-after-trigger"]'
      )
    ),
    0
  )
  await control.command('click', '[data-testid="execution-node-review"]', { visible: true })
  await control.command('waitFor', '[data-testid="automation-settings-fields"]:disabled', {
    visible: true,
  })
  await captureScreenshot(control, 'experience-permission-02-role-inspection.png', 'body')
  const location = new URL(JSON.parse(await control.command('snapshot', 'body')).location)
  const boardPath = `/todo${location.search}`
  const reopenExperience = async () => {
    await control.command('navigate', 'body', { value: boardPath })
    await control.command('waitFor', '[data-testid="cloud-project-automation-view"]', {
      visible: true,
    })
    await control.command('click', '[data-testid="cloud-project-automation-view"]', {
      visible: true,
    })
    await control.command('waitFor', `[data-testid="automation-card-${rule.id}"]`, {
      visible: true,
    })
    await control.command('click', `[data-testid="automation-card-${rule.id}"]`, { visible: true })
  }
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-mode-dark"]', { visible: true })
  await control.command('click', '[data-testid="appearance-mode-dark"]')
  await control.command('waitFor', 'html.dark')
  await reopenExperience()
  await control.command('waitFor', '[data-testid="automation-read-only"]', {
    text: '只读',
    visible: true,
  })
  await captureScreenshot(control, 'experience-display-01-dark.png', 'body')
  await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1024, height: 768 }),
  })
  await control.command('waitFor', '[data-testid="automation-editor-back"]', { visible: true })
  const assertToolbarDoesNotOverlap = async () => {
    const [navigation] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="automation-editor-section-menu"]')
    )
    const [actions] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="automation-editor-global-actions"]')
    )
    const [editor] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="automation-rule-editor"]')
    )
    assert.ok(navigation.right <= actions.left, 'Global advancement overlaps editor navigation')
    assert.ok(actions.right <= editor.right, 'Global advancement extends outside the canvas')
    const [back] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="automation-editor-back"]')
    )
    const [name] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="automation-editor-name"]')
    )
    assert.ok(back.width >= 28 && back.left >= editor.left, 'The toolbar clips the back button')
    assert.ok(
      name.width >= 32 && name.right <= navigation.left,
      'The toolbar hides the automation name'
    )
  }
  await assertToolbarDoesNotOverlap()
  await captureScreenshot(control, 'experience-display-02-narrow.png', 'body')
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('waitFor', '[data-testid="general-language-en-button"]', { visible: true })
  await control.command('click', '[data-testid="general-language-en-button"]')
  await control.command(
    'waitFor',
    '[data-testid="general-language-en-button"][aria-pressed="true"]'
  )
  await reopenExperience()
  await control.command('waitFor', '[data-testid="automation-read-only"]', {
    text: 'Read only',
    visible: true,
  })
  await assertToolbarDoesNotOverlap()
  await captureScreenshot(control, 'experience-display-03-english.png', 'body')
  await control.command('click', '[data-testid="automation-editor-back"]', { visible: true })
  await control.command('waitFor', `[data-testid="automation-card-${rule.id}"]`, { visible: true })
}
