import assert from 'node:assert/strict'

import { expandCollaborationWorkspace, reloadMainWindow } from './workspace-flows.mjs'

export async function openProjectBoard(control, scoped, project) {
  await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await expandCollaborationWorkspace(
    control,
    scoped(`[data-testid="collaboration-workspace-toggle-${project.workspace_id}"]`)
  )
  // Restored expansion does not prove that the refreshed project rows are mounted.
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
  )
  await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
    text: project.name,
  })
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-board"]'))
}

export async function selectProjectBoardSort(control, scoped, columnKey, rules = []) {
  const testId = `cloud-board-sort-by-${columnKey}`
  const trigger = scoped(`[data-testid="${testId}"]`)
  await control.command('click', trigger)
  await control.command('click', `[data-testid="${testId}-manual"]`)
  for (const [index, rule] of rules.entries()) {
    await control.command('click', `[data-testid="${testId}-add"]`)
    await control.command('click', `[data-testid="${testId}-rule-${index}-mode"]`)
    await control.command('click', `[data-testid="${testId}-rule-${index}-mode-${rule}"]`)
  }
  await control.command('click', trigger)
  await control.command('waitFor', `${trigger}[data-sort-rules="${rules.join(',') || 'manual'}"]`)
}

export async function assertProjectBoardGrouping(control, scoped, groupBy) {
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-board-group-by"][data-value="${groupBy}"]`),
    { stableMs: 500 }
  )
  assert.doesNotMatch(
    await control.command('getText', scoped('[data-testid="collaboration-root"]')),
    /保存失败|Could not save/,
    'Changing a personal board view must not report a project save failure'
  )
}

export async function selectProjectBoardGrouping(control, scoped, groupBy) {
  await control.command('click', scoped('[data-testid="cloud-board-group-by"]'))
  await control.command('click', `[data-testid="cloud-board-group-option-${groupBy}"]`)
  await assertProjectBoardGrouping(control, scoped, groupBy)
}

async function assertProjectConfigurationUnchanged(request, projectId, before) {
  const after = await request(`/api/v1/cloud-projects/${projectId}`)
  assert.equal(after.version, before.version, 'Personal board changes advanced the project version')
  assert.deepEqual(
    after.board_config,
    before.board_config,
    'Personal board changes modified the shared project board configuration'
  )
}

export async function verifyPersonalBoardGrouping(control, { scoped, request, project, groupBy }) {
  const before = await request(`/api/v1/cloud-projects/${project.id}`)
  await selectProjectBoardGrouping(control, scoped, groupBy)
  await reloadMainWindow(control, 'The desktop did not reconnect after changing the personal view')
  await openProjectBoard(control, scoped, project)
  await assertProjectBoardGrouping(control, scoped, groupBy)
  await assertProjectConfigurationUnchanged(request, project.id, before)
}

export async function createBoardFilterIssues(request, project, currentUser, peer) {
  const definitions = [
    { title: '负责人筛选-共同关键词-我的任务', assignee_user_id: currentUser.id },
    { title: '负责人筛选-共同关键词-其他成员任务', assignee_user_id: peer.id },
    { title: '负责人筛选-未分配任务' },
  ]
  const issues = []
  for (const definition of definitions) {
    let issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
      method: 'POST',
      body: JSON.stringify(definition),
    })
    if (definition.assignee_user_id == null) {
      issue = await request(`/api/v1/loop-items/${issue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: issue.version, assignee_user_id: null }),
      })
    }
    assert.equal(issue.assignee_user_id, definition.assignee_user_id ?? null)
    for (const field of ['assignee_agent_id', 'assignee_team_id', 'assignee_group_id']) {
      assert.equal(issue[field], null, `The filter fixture unexpectedly has ${field}`)
    }
    issues.push(issue)
  }
  return issues
}

async function assertFilteredIssues(control, scoped, issues, visibleIds) {
  for (const issue of issues) {
    await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`), {
      visible: visibleIds.includes(issue.id),
    })
  }
}

export async function verifyPersonalAssigneeFilter(
  control,
  { scoped, request, project, currentUser, issues, expectedRole = 'Developer' }
) {
  const before = await request(`/api/v1/cloud-projects/${project.id}`)
  assert.equal(before.access_role, expectedRole, 'The filter regression has the wrong project role')
  const filter = scoped('[data-testid="cloud-board-group-filter"]')
  const search = scoped('[data-testid="cloud-board-search"]')
  const mine = issues[0]
  await assertProjectBoardGrouping(control, scoped, 'status')
  await selectProjectBoardGrouping(control, scoped, 'assignee')
  await control.command('select', filter, { value: `assignee-${currentUser.id}` })
  await assertFilteredIssues(control, scoped, issues, [mine.id])
  await control.command('fill', search, { value: '共同关键词' })
  await assertFilteredIssues(control, scoped, issues, [mine.id])
  await control.command('fill', search, { value: '未分配任务' })
  await assertFilteredIssues(control, scoped, issues, [])
  await control.command('fill', search, { value: '' })
  await assertFilteredIssues(control, scoped, issues, [mine.id])
  await control.command('select', filter, { value: `assignee-${issues[1].assignee_user_id}` })
  await assertFilteredIssues(control, scoped, issues, [issues[1].id])
  await control.command('select', filter, { value: 'assignee-unassigned' })
  await assertFilteredIssues(control, scoped, issues, [issues[2].id])
  await control.command('select', filter, { value: '' })
  await assertFilteredIssues(
    control,
    scoped,
    issues,
    issues.map(issue => issue.id)
  )
  await assertProjectBoardGrouping(control, scoped, 'assignee')
  await control.command('select', filter, { value: `assignee-${currentUser.id}` })
  await control.command('fill', search, { value: '共同关键词' })
  await reloadMainWindow(control, 'The desktop did not reconnect after filtering my Issues')
  await openProjectBoard(control, scoped, project)
  await assertProjectBoardGrouping(control, scoped, 'assignee')
  assert.equal(await control.command('getValue', filter), '')
  assert.equal(await control.command('getValue', search), '')
  await assertFilteredIssues(
    control,
    scoped,
    issues,
    issues.map(issue => issue.id)
  )
  await assertProjectConfigurationUnchanged(request, project.id, before)
  console.log(
    `[desktop-e2e] PASS personal-board: ${expectedRole} own-Issue filter/search/clear/reload did not modify shared project settings`
  )
}
