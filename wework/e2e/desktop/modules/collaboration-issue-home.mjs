import assert from 'node:assert/strict'

import { inCollaborationSidebar } from './workspace-flows.mjs'

// Invoked by collaboration-shared-core after its real project/agent fixtures exist.
export async function verifyCollaborationIssueHome(
  control,
  { request, project, issue, owner, agent, scoped }
) {
  const group = await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Issue 首页验收小队',
      leader: { kind: 'human', id: String(owner.id) },
      members: [{ kind: 'human', id: String(owner.id) }],
    }),
  })
  const projectRow = inCollaborationSidebar(
    `[data-testid="collaboration-workspace-project-${project.id}"]`
  )
  const newConversation = inCollaborationSidebar(
    `[data-testid="collaboration-project-new-conversation-${project.id}"]`
  )
  const input = scoped(
    '[data-testid="collaboration-issue-workspace"] [data-testid="collaboration-home-issue-content"]'
  )
  const ownerButton = scoped('[data-testid="collaboration-issue-owner"]')
  const openComposer = async () => {
    await control.command('hover', projectRow)
    await control.command('click', newConversation)
    await control.command('waitFor', input)
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-issue-project-trigger"]'),
      { text: project.name }
    )
  }
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  assert.equal(
    Number(await control.command('getElementCount', `${projectRow} svg`)),
    0,
    'Project names must not have folder icons'
  )
  await control.command('hover', projectRow)
  assert.equal(
    await control.command('getComputedStyleValue', `${newConversation}`, { value: 'height' }),
    '28px'
  )
  const rowHeight = await control.command(
    'getComputedStyleValue',
    '.collaboration-workspace-project-row',
    { value: 'height' }
  )
  assert.equal(
    rowHeight,
    '30px',
    'The trailing action must not add a second line to the project row'
  )

  await openComposer()
  const environmentNotice = scoped('[data-testid="issue-execution-environment-notice"]')
  await control.command('waitFor', environmentNotice, { text: 'Issue 仍可创建' })
  await control.command(
    'click',
    scoped('[data-testid="issue-execution-environment-notice-action"]')
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-project-settings-environments"]')
  )
  assert.equal(
    await control.command(
      'getAttribute',
      scoped('[data-testid="collaboration-project-settings-environments"]'),
      { value: 'aria-current' }
    ),
    'page',
    'The environment notice action did not open project execution environment settings'
  )

  const cases = [
    {
      kind: 'member',
      id: String(owner.id),
      name: owner.user_name,
      field: 'assignee_user_id',
      icon: 'member',
    },
    {
      kind: 'agent',
      id: String(agent.id),
      name: agent.name,
      field: 'assignee_agent_id',
      icon: 'agent',
    },
    {
      kind: 'group',
      id: String(group.id),
      name: group.name,
      field: 'assignee_group_id',
      icon: 'group',
    },
  ]
  for (const target of cases) {
    await openComposer()
    const marker = `首页负责人-${target.kind}-${Date.now()}`
    await control.command('fill', input, { value: `${marker} @` })
    for (const candidate of cases) {
      await control.command(
        'waitFor',
        `[data-testid="collaboration-home-mention-${candidate.kind}-${candidate.id}"]`
      )
    }
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="local-skill-plan-mode"]')),
      0
    )
    await control.command(
      'click',
      `[data-testid="collaboration-home-mention-${target.kind}-${target.id}"]`
    )
    await control.command('waitFor', `${input} [data-composer-reference-kind="${target.icon}"]`)
    await control.command('waitFor', ownerButton, { text: target.name })

    await control.command('click', scoped('[data-testid="collaboration-issue-reference_issue"]'))
    await control.command('waitFor', `[data-testid="collaboration-home-mention-issue-${issue.id}"]`)
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          '[data-testid^="collaboration-home-mention-member-"]'
        )
      ),
      0,
      '# must only show Issues'
    )
    await control.command('click', `[data-testid="collaboration-home-mention-issue-${issue.id}"]`)
    await control.command('waitFor', `${input} [data-composer-reference-kind="issue"]`)
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-home-create-issue"]')
    )
    await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
      text: project.name,
    })
    const created = (await request(`/api/v1/cloud-projects/${project.id}/loop-items`)).items.find(
      item => item.description?.includes(marker)
    )
    assert.ok(created, 'Issue creation did not persist the composer content')
    assert.equal(String(created[target.field]), target.id, `${target.kind} owner was not persisted`)
    assert.match(created.description, /wework-issue:\/\//)
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  }

  await openComposer()
  await control.command('fill', input, { value: '手动修改负责人 @' })
  await control.command('click', `[data-testid="collaboration-home-mention-member-${owner.id}"]`)
  await control.command('click', ownerButton)
  await control.command('click', `[data-testid="collaboration-issue-owner-group:${group.id}"]`)
  await control.command('waitFor', ownerButton, { text: group.name })
  assert.equal(Number(await control.command('getElementCount', `${ownerButton} select`)), 0)
  await control.command('fill', input, { value: '/plan' })
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="slash-command-menu"]')),
    0
  )
  await control.command('waitFor', ownerButton, { text: group.name })
  await control.command('click', ownerButton)
  await control.command('click', '[data-testid="collaboration-issue-owner-none"]')
  assert.equal((await control.command('getText', ownerButton)).trim(), '')
  await control.command('fill', input, { value: '' })
  await control.command('click', projectRow)
  await control.command('click', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
  await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'))
}
