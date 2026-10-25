import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const ERROR = `${CONTENT} [data-testid="cloud-todo-save-error"]`

async function saveSilently(control, testId) {
  await control.command('click', `${CONTENT} [data-testid="${testId}-options"]`)
  await control.command('click', `[data-testid="${testId}-without-notification"]`, {
    visible: true,
  })
}

/** Exercise real backend rejection and retry without intercepting assignment requests. */
export async function verifySilentIssueSaves({
  control,
  projectId,
  owner,
  request,
  requestJson,
  createIssue,
  waitForValue,
  uiTimeoutMs,
  capture,
}) {
  const userName = `desktop-silent-assignee-${process.pid}`
  const password = `desktop-silent-password-${process.pid}`
  const member = await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password, role: 'user', auth_source: 'password' }),
  })
  const login = await requestJson(null, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password }),
  })
  assert.ok(login.access_token, 'The recipient fixture did not receive a login token')
  await request(`/api/v1/cloud-projects/${projectId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: member.id, role: 'Developer' }),
  })
  const setRole = role =>
    request(`/api/v1/cloud-projects/${projectId}/members/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    })
  const assertNoNotification = async issueId => {
    const inbox = await requestJson(
      login.access_token,
      '/api/v1/wework-notifications?category=collaboration'
    )
    assert.deepEqual(
      inbox.items.filter(
        item =>
          item.kind === 'issue_dispatch_assignment' &&
          (item.payload?.issueId === issueId || item.payload?.itemId === issueId)
      ),
      [],
      'Silent saving wrote an assignment notification to the real recipient inbox'
    )
  }
  const selectAssignee = async userId => {
    await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-assignee"]`)
    await control.command(
      'clickWhenEnabled',
      `[data-testid="cloud-todo-detail-assignee-option-user:${userId}"]`,
      { visible: true }
    )
  }
  const title = `静默保存验收-${process.pid}`
  let draftDescription = ''
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  const created = await createIssue(control, projectId, request, member, uiTimeoutMs, title, {
    notifyAssignee: false,
    beforeSave: async () => {
      draftDescription = await control.command(
        'getValue',
        `${CONTENT} [data-testid="cloud-todo-detail-description"]`
      )
      assert.ok(draftDescription.length > 0)
      await setRole('Viewer')
      await saveSilently(control, 'cloud-todo-create-confirm')
      await control.command('waitFor', ERROR, { text: 'Assignee is not a member', visible: true })
      assert.equal(
        await control.command('getValue', `${CONTENT} [data-testid="cloud-todo-title"]`),
        title
      )
      assert.equal(
        await control.command(
          'getValue',
          `${CONTENT} [data-testid="cloud-todo-detail-description"]`
        ),
        draftDescription
      )
      assert.equal(
        await control.command(
          'getAttribute',
          `${CONTENT} [data-testid="cloud-todo-create-assignee"]`,
          { value: 'data-value' }
        ),
        `user:${member.id}`
      )
      const items = await request(`/api/v1/cloud-projects/${projectId}/loop-items`)
      assert.equal(
        items.items.some(item => item.title === title),
        false,
        'Failed creation persisted an Issue'
      )
      await capture('assignment-09-silent-create-rejected-draft-preserved.png')
      await setRole('Developer')
    },
  })
  assert.equal(String(created.assignee_user_id), String(member.id))
  assert.equal(created.status, 'inbox')
  assert.equal(created.description, draftDescription)
  await assertNoNotification(created.id)
  await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail"]`)
  assert.equal(Number(await control.command('getElementCount', ERROR)), 0)
  await capture('assignment-10-silent-create-persisted.png')

  // Establish a different owner before the UI reassigns to the non-acting recipient.
  await selectAssignee(owner.id)
  await saveSilently(control, 'cloud-todo-save')
  await waitForValue(
    () => request(`/api/v1/loop-items/${created.id}`),
    item => String(item.assignee_user_id) === String(owner.id),
    'The intermediate owner was not persisted',
    uiTimeoutMs
  )
  await control.command(
    'waitFor',
    `${CONTENT} [data-testid="cloud-todo-detail-assignee"][data-value="user:${owner.id}"]`
  )
  await selectAssignee(member.id)
  await setRole('Viewer')
  await saveSilently(control, 'cloud-todo-save')
  await control.command('waitFor', ERROR, { text: 'Assignee is not a member', visible: true })
  assert.equal(
    await control.command('getAttribute', `${CONTENT} [data-testid="cloud-todo-detail-assignee"]`, {
      value: 'data-value',
    }),
    `user:${member.id}`
  )
  const rejected = await request(`/api/v1/loop-items/${created.id}`)
  assert.equal(String(rejected.assignee_user_id), String(owner.id))
  assert.equal(rejected.status, created.status)
  assert.equal(rejected.description, created.description)
  await assertNoNotification(created.id)
  await capture('assignment-11-silent-reassignment-rejected.png')
  await setRole('Developer')
  await saveSilently(control, 'cloud-todo-save')
  const reassigned = await waitForValue(
    () => request(`/api/v1/loop-items/${created.id}`),
    item => String(item.assignee_user_id) === String(member.id),
    'Silent reassignment was not persisted after restoring membership',
    uiTimeoutMs
  )
  assert.equal(reassigned.status, created.status)
  assert.equal(reassigned.title, title)
  assert.equal(reassigned.description, created.description)
  await control.command(
    'waitFor',
    `${CONTENT} [data-testid="cloud-todo-detail-assignee"][data-value="user:${member.id}"]`
  )
  assert.equal(Number(await control.command('getElementCount', ERROR)), 0)
  await assertNoNotification(created.id)
  await capture('assignment-12-silent-reassignment-persisted.png')
}
