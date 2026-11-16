import assert from 'node:assert/strict'

const testId = id => `[data-testid="${id}"]`

/** Resolve a real optimistic-lock conflict without overwriting a concurrent edit. */
export async function verifyIssueConflictRecovery(control, { request, reopen, captureScreenshot }) {
  const title = `Version conflict recovery ${process.pid}`
  await reopen()
  await control.command('fill', testId('independent-issue-title'), { value: title })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-edit'), { visible: true })
  const row = (await request('/api/v1/personal-issues?scope=created')).items.find(
    item => item.title === title
  )
  assert.ok(row)
  await control.command('clickWhenEnabled', testId('independent-issue-edit'))
  await control.command('fill', testId('independent-issue-description'), {
    value: 'Local unsaved draft',
  })
  const concurrent = await request(`/api/v1/personal-issues/${row.id}`, 'PATCH', {
    title,
    description: 'Concurrent server edit',
    assignee_id: row.assignee_id,
    version: row.version,
  })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-reload'), { visible: true })
  assert.equal(
    (await request(`/api/v1/personal-issues/${row.id}`)).description,
    'Concurrent server edit'
  )
  await captureScreenshot(control, 'new-issue-version-conflict.png')
  await control.command('clickWhenEnabled', testId('independent-issue-reload'))
  await control.command('waitFor', testId('independent-issue-discard-dialog'), { visible: true })
  await captureScreenshot(control, 'new-issue-version-conflict-reload-confirm.png')
  await control.command(
    'clickWhenEnabled',
    testId('independent-issue-discard-confirm-cancel-button')
  )
  assert.equal(
    await control.command('getValue', testId('independent-issue-description')),
    'Local unsaved draft'
  )
  await control.command('clickWhenEnabled', testId('independent-issue-reload'))
  await control.command('clickWhenEnabled', testId('independent-issue-discard-confirm'))
  await control.command('waitFor', testId('independent-issue-edit'), { visible: true })
  await control.command('clickWhenEnabled', testId('independent-issue-edit'))
  assert.equal(
    await control.command('getValue', testId('independent-issue-description')),
    'Concurrent server edit'
  )
  await control.command('fill', testId('independent-issue-description'), {
    value: 'Explicitly revised after reload',
  })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-edit'), { visible: true })
  const resolved = await request(`/api/v1/personal-issues/${row.id}`)
  assert.equal(resolved.description, 'Explicitly revised after reload')
  assert.ok(resolved.version > concurrent.version)
  assert.deepEqual(
    (await request('/api/v1/personal-issues?scope=created')).items
      .filter(item => item.title === title)
      .map(item => item.id),
    [row.id]
  )
  await control.command('clickWhenEnabled', testId('independent-issue-close'))
  await control.command('waitFor', testId('independent-issue-dialog'), { visible: false })
}

/** The asynchronously loaded device selector uses the larger side of a narrow window. */
export async function verifyIssueDeviceLayout(control, deviceId) {
  const trigger = testId('issue-environment-picker-trigger')
  const picker = testId('issue-environment-picker')
  const prefix = 'collaboration-project-execution-environment'
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', picker, { visible: false })
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 390, height: 844 }),
  })
  try {
    await control.command('scrollIntoView', trigger)
    await control.command('clickWhenEnabled', trigger)
    await control.command('waitFor', testId(`${prefix}-${deviceId}`), { visible: true })
    await control.command('waitFor', testId(`${prefix}-picker`), { visible: true })
    await control.command('waitFor', testId(`${prefix}-picker-loading`), { visible: false })
    const metrics = async selector =>
      JSON.parse(await control.command('getElementMetrics', selector))
    const [anchor] = await metrics(trigger)
    const [panel] = await metrics(picker)
    const available = Math.max(anchor.top - 14, panel.viewportHeight - anchor.bottom - 14)
    assert.ok(
      panel.height >= Math.min(panel.scrollHeight, available) - 2,
      'Loaded devices must use the available side instead of a cramped loading popup'
    )
    assert.ok(
      panel.top >= 7 && panel.bottom <= panel.viewportHeight - 7,
      'Device selection must remain inside the narrow window'
    )
    const more = testId(`${prefix}-actions-toggle-${deviceId}`)
    await control.command('scrollIntoView', more)
    await control.command('clickWhenEnabled', more)
    const preparation = testId(`${prefix}-initialize-${deviceId}`)
    await control.command('scrollIntoView', preparation)
    const [action] = await metrics(preparation)
    assert.ok(
      action.visibleIntersection?.width >= action.width - 1 &&
        action.scrollWidth <= action.clientWidth,
      'The complete project preparation action must fit inside the narrow device panel'
    )
    const controls = (
      await metrics(`${picker} button, ${picker} select, ${picker} summary`)
    ).filter(control => control.height > 0)
    assert.ok(controls.length > 0)
    for (const control of controls) {
      assert.ok(
        control.height >= 44 && control.width >= 44,
        'Every visible device action must have a 44px touch target'
      )
    }
    await control.command('nativePress', preparation, { key: 'Escape' })
    await control.command('waitFor', picker, { visible: false })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
  await control.command('scrollIntoView', trigger)
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', picker, { visible: true })
}

/** Recover a real partial save after the selected project is archived elsewhere. */
export async function verifyIssueAssociationRecovery(control, { request, reopen }) {
  const title = `Association recovery ${process.pid}`
  const project = await request(
    '/api/v1/cloud-projects',
    'POST',
    {
      name: title,
      task_provider: 'local',
      visibility: 'private',
    },
    undefined,
    201
  )
  await reopen()
  await control.command('fill', testId('independent-issue-title'), { value: title })
  await control.command(
    'waitFor',
    `${testId('independent-issue-project')} option[value="${project.id}"]`
  )
  await control.command('select', testId('independent-issue-project'), {
    value: String(project.id),
  })
  await request(
    `/api/v1/cloud-projects/${project.id}?version=${project.version}`,
    'DELETE',
    undefined,
    undefined,
    204
  )
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-association-pending'), {
    visible: true,
  })
  const saved = (await request('/api/v1/personal-issues?scope=created')).items.filter(
    row => row.title === title
  )
  assert.equal(saved.length, 1, 'A failed association must retain exactly one saved Issue')
  await control.command('select', testId('independent-issue-project'), { value: '' })
  await control.command('fill', testId('independent-issue-title'), { value: `${title} recovered` })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-edit'), { visible: true })
  const recovered = await request(`/api/v1/personal-issues/${saved[0].id}`)
  assert.equal(recovered.title, `${title} recovered`)
  assert.ok(recovered.version > saved[0].version, 'Recovery must update the saved version')
  const remaining = (await request('/api/v1/personal-issues?scope=created')).items.filter(row =>
    row.title.startsWith(title)
  )
  assert.deepEqual(
    remaining.map(row => row.id),
    [saved[0].id],
    'Recovery must not create a duplicate'
  )
  await control.command('clickWhenEnabled', testId('independent-issue-close'))
  await control.command('waitFor', testId('independent-issue-dialog'), { visible: false })
  await reopen()
}

/** Verify draft safety and bounded layout without creating an Issue. */
export async function verifyIndependentIssueDraft(
  control,
  { request, reopen, opener, captureScreenshot }
) {
  const before = await request('/api/v1/personal-issues?scope=created')
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1100, height: 700 }),
  })
  const title = 'Unsaved Issue keyboard regression'
  const description = 'Keep the draft until an explicit discard.'
  const metrics = async id => JSON.parse(await control.command('getElementMetrics', testId(id)))[0]
  try {
    await control.command('clickWhenEnabled', testId('independent-issue-editor-cancel'))
    await control.command('waitFor', testId('independent-issue-dialog'), { visible: false })
    await reopen()
    await control.command('waitFor', testId('independent-issue-title'), { visible: true })
    await control.command('fill', testId('independent-issue-title'), { value: title })
    await control.command('fill', testId('independent-issue-description'), { value: description })
    await control.command('waitFor', `${testId('independent-issue-save')}:not(:disabled)`)
    const initial = await metrics('independent-issue-editor-actions')
    assert.ok(
      initial.top >= 0 && initial.bottom <= initial.viewportHeight,
      'Actions must remain inside a short viewport'
    )
    await control.command('clickWhenEnabled', testId('issue-participant-add'))
    await control.command('waitFor', testId('independent-issue-search-people'), { visible: true })
    const expanded = await metrics('independent-issue-editor-actions')
    assert.ok(
      Math.abs(expanded.top - initial.top) <= 1,
      'Participant selection must not move the footer'
    )
    await control.command('nativePress', testId('independent-issue-search-people'), {
      key: 'Enter',
    })
    const submitted = JSON.parse(
      await control.command('sampleElementPresence', testId('independent-issue-edit'), {
        value: '300',
      })
    )
    assert.equal(submitted.observed, false, 'Search Enter must not create an Issue')
    await control.command('nativePress', testId('independent-issue-search-people'), {
      key: 'Escape',
    })
    await control.command('waitFor', testId('issue-participant-picker'), { visible: false })
    assert.equal(await control.command('getValue', testId('independent-issue-title')), title)
    await control.command('nativePress', testId('independent-issue-title'), { key: 'Escape' })
    await control.command('waitFor', testId('independent-issue-discard-dialog'), { visible: true })
    await control.command(
      'clickWhenEnabled',
      testId('independent-issue-discard-confirm-cancel-button')
    )
    await control.command('waitFor', testId('independent-issue-title'), { visible: true })
    assert.equal(await control.command('getValue', testId('independent-issue-title')), title)
    assert.equal(
      await control.command('getValue', testId('independent-issue-description')),
      description
    )
    const save = await metrics('independent-issue-save')
    assert.equal(
      save.hitTestVisible,
      true,
      'Create must remain reachable after returning to the draft'
    )
    await captureScreenshot(control, 'new-issue-protected-draft-short-window.png')
    await control.command('clickWhenEnabled', testId('independent-issue-editor-cancel'))
    await control.command('waitFor', testId('independent-issue-discard-dialog'), { visible: true })
    await control.command('clickWhenEnabled', testId('independent-issue-discard-confirm'))
    await control.command('waitFor', testId('independent-issue-dialog'), { visible: false })
    await control.command('waitFor', `${opener}:focus`, { visible: true })
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      'collaboration-primary-create-issue',
      'Discarding the draft must return keyboard focus to the opener'
    )
    const after = await request('/api/v1/personal-issues?scope=created')
    assert.deepEqual(
      after.items.map(row => row.id),
      before.items.map(row => row.id),
      'Keyboard navigation and discard must not persist an Issue'
    )
    await reopen()
    await control.command('waitFor', testId('independent-issue-title'), { visible: true })
    assert.equal(await control.command('getValue', testId('independent-issue-title')), '')
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
}
