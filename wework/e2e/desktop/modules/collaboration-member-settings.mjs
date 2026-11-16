import assert from 'node:assert/strict'
import { reloadMainWindow } from './workspace-flows.mjs'
import {
  selectCollaborationProjectView,
  waitForProjectIdentity,
} from './collaboration-project-navigation.mjs'

export async function selectProjectCreateMembers(control, { members, owner }) {
  await control.command('click', '[data-testid="collaboration-project-create-add-collaborator"]')
  const search = '[data-testid="collaboration-project-create-people-search"]'
  await control.command('waitFor', search, { visible: true })
  await control.command('fill', search, { value: owner.user_name })
  await control.command(
    'waitFor',
    '[data-testid="collaboration-project-create-collaborator-menu"] p',
    { text: '暂无其他可添加项', visible: true, stableMs: 250 }
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `[data-testid="collaboration-project-create-member-${owner.id}"]`
      )
    ),
    0,
    'Searching for the creator must not offer a duplicate project membership'
  )
  await control.command('press', search, { key: 'Escape' })
  for (const member of members) {
    await control.command('click', '[data-testid="collaboration-project-create-add-collaborator"]')
    await control.command('waitFor', search, { visible: true })
    await control.command('fill', search, { value: member.user_name })
    const option = `[data-testid="collaboration-project-create-member-${member.id}"]`
    await control.command('waitFor', option, { visible: true })
    await control.command('click', option)
    await control.command(
      'waitFor',
      `[data-testid="collaboration-project-create-selected-member-${member.id}"]`,
      { text: member.user_name }
    )
  }
}

async function assertCreatedMembers(control, { scoped, members, owner, request, project }) {
  const roster = await request(`/api/v1/cloud-projects/${project.id}/members`)
  assert.equal(new Set(roster.map(member => member.user_id)).size, roster.length)
  assert.equal(roster.filter(member => member.user_id === owner.id).length, 1)
  for (const member of members) {
    const persisted = roster.find(candidate => candidate.user_id === member.id)
    assert.ok(persisted, `The selected member ${member.user_name} was not persisted`)
    assert.equal(persisted.role, 'Developer')
    assert.equal(persisted.direct_role, 'Developer')
    await control.command('waitFor', scoped(`[data-testid="cloud-project-member-${member.id}"]`), {
      text: member.user_name,
    })
  }
}

// Called by the existing shared-core checkpoint after creating its own project.
export async function verifyCollaborationMemberSettings(
  control,
  { scoped, owner, request, project, members }
) {
  await selectCollaborationProjectView(control, scoped('').trim(), 'manage')
  await control.command('click', scoped('[data-testid="collaboration-project-settings-members"]'))
  const row = scoped(`[data-testid="cloud-project-member-${owner.id}"]`)
  await control.command('waitFor', row)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${row} > [role="cell"], ${row} > [role="rowheader"]`
      )
    ),
    4,
    'Identity, responsibilities, role/source and actions must occupy exactly four columns'
  )
  const roster = await request(`/api/v1/cloud-projects/${project.id}/members`)
  const member = roster.find(candidate => candidate.user_id === owner.id)
  assert.equal(member.inherited_role, 'Maintainer')
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-project-member-effective-role-${owner.id}"]`),
    {
      text: '管理员',
    }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-project-member-source-${owner.id}"]`),
    {
      text: '继承自',
    }
  )
  if (!member.direct_role) {
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          scoped(`[data-testid="cloud-project-member-role-${owner.id}"]`)
        )
      ),
      0
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          scoped(`[data-testid="cloud-project-member-remove-${owner.id}"]`)
        )
      ),
      0
    )
  }
  await control.command('waitFor', scoped('[data-testid="cloud-project-members-inheritance-note"]'))
  await assertCreatedMembers(control, { scoped, members, owner, request, project })
  await reloadMainWindow(control, 'The created project members did not reconnect after reload')
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await waitForProjectIdentity(control, scoped('').trim(), project.name)
  await selectCollaborationProjectView(control, scoped('').trim(), 'manage')
  await control.command('click', scoped('[data-testid="collaboration-project-settings-members"]'))
  await assertCreatedMembers(control, { scoped, members, owner, request, project })
  await selectCollaborationProjectView(control, scoped('').trim(), 'board')
}
