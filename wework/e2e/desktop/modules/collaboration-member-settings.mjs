import assert from 'node:assert/strict'

// Called by the existing shared-core checkpoint after creating its own project.
export async function verifyCollaborationMemberSettings(
  control,
  { scoped, owner, request, project }
) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
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
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
}
