import assert from 'node:assert/strict'
import { until } from './plugin-regression-fixture.mjs'
import { waitForAttribute } from './workspace-flows.mjs'

const testId = id => `[data-testid="${id}"]`

export async function verifyIssueCreationColumns(control) {
  const metric = async id => JSON.parse(await control.command('getElementMetrics', testId(id)))[0]
  const people = await metric('independent-issue-search-people')
  const title = await metric('independent-issue-title')
  const todo = await metric('independent-issue-description')
  assert.ok(
    people.right < todo.left && title.bottom < todo.top,
    'A wide creation dialog must show participants beside the issue content'
  )
}

async function setIssueTestLanguage(control, language) {
  await control.command('clickWhenEnabled', testId('settings-button'))
  await control.command('clickWhenEnabled', testId('settings-menu-button'))
  await control.command('clickWhenEnabled', testId('settings-nav-general'))
  await control.command('clickWhenEnabled', testId(`general-language-${language}-button`))
  await waitForAttribute(control, 'html', 'lang', language)
  await control.command('clickWhenEnabled', testId('settings-back-button'))
  await control.command('clickWhenEnabled', testId('workspace-tab-select-fixed-board'))
}

/** Selected projects and their permission context must reflow with longer English labels. */
export async function verifyEnglishLinkedIssueLayout(
  control,
  { project, reopen, captureScreenshot }
) {
  await setIssueTestLanguage(control, 'en')
  await reopen()
  await waitForAttribute(
    control,
    testId('independent-issue-project'),
    'aria-label',
    'Project association'
  )
  await control.command('fill', testId('independent-issue-title'), {
    value: 'Unsubmitted English reflow regression',
  })
  await chooseIssueProperty(control, 'independent-issue-project', String(project.id), project.name)
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 390, height: 568 }),
  })
  try {
    await control.command('scrollIntoView', testId('independent-issue-project'))
    await captureScreenshot(control, 'new-issue-english-linked-narrow.png')
    const metric = async selector =>
      JSON.parse(await control.command('getElementMetrics', selector))[0]
    const scroll = await metric(testId('independent-issue-editor-scroll'))
    const people = await metric(testId('independent-issue-search-people'))
    const todo = await metric(testId('independent-issue-description'))
    assert.ok(people.bottom <= todo.top, 'A narrow creation dialog must stack both columns')
    assert.equal(
      await control.command('getText', testId('issue-project-selected-name')),
      project.name
    )
    const picker = await control.command('getText', testId('independent-issue-project'))
    assert.ok(!picker.includes(project.project_key), 'Hide the project key in the closed picker')
    assert.equal(
      await control.command('getText', testId('issue-project-scope')),
      'Follows project access rules'
    )
    const scope = await metric(testId('issue-project-scope'))
    assert.ok(
      scope.scrollWidth <= scope.clientWidth + 1 &&
        scope.visibleIntersection?.width >= scope.width - 1 &&
        scope.visibleIntersection?.height >= scope.height - 1,
      'The short permission text must remain fully readable in the closed narrow-window picker'
    )
    assert.ok(
      scroll.scrollWidth <= scroll.clientWidth + 1,
      'A linked English Issue must not introduce horizontal scrolling'
    )
    for (const selector of [
      testId('independent-issue-project'),
      testId('issue-project-scope'),
      testId('issue-participants'),
      `${testId('independent-issue-project')} > svg`,
    ]) {
      const row = await metric(selector)
      assert.ok(
        row.left >= scroll.left - 1 && row.right <= scroll.right + 1,
        'Project selection, its arrow, permission copy and participants must stay inside the editor'
      )
    }
    const actions = await metric(testId('independent-issue-editor-actions'))
    assert.ok(
      actions.top >= 0 && actions.bottom <= actions.viewportHeight,
      'The English narrow-window footer must remain reachable'
    )
    await control.command('clickWhenEnabled', testId('independent-issue-editor-cancel'))
    await control.command('clickWhenEnabled', testId('independent-issue-discard-confirm'))
    await control.command('waitFor', testId('independent-issue-dialog'), { visible: false })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
  await setIssueTestLanguage(control, 'zh-CN')
}

/** Send a real Electron key event to the Issue control without switching app focus. */
export async function pressFocusedIssueKey(control, selector, key) {
  await control.command('focus', selector)
  await control.command('pressWindowKey', selector, { key })
}

/** Exercise the shared searchable property picker with real keyboard input. */
export async function chooseIssueProperty(control, id, value, query = '') {
  await control.command('clickWhenEnabled', testId(id))
  const search = testId(`${id}-search`)
  await control.command('waitFor', search, { visible: true })
  assert.equal(await control.command('getActiveElementTestId', 'body'), `${id}-search`)
  await control.command('fill', search, { value: query })
  const optionId = `${id}-option-${value || 'empty'}`
  await control.command('waitFor', testId(optionId), { visible: true })
  await pressFocusedIssueKey(control, search, 'ArrowDown')
  const option = testId(optionId)
  const activeDescendant = await control.command('getAttribute', search, {
    value: 'aria-activedescendant',
  })
  const optionDomId = await control.command('getAttribute', option, { value: 'id' })
  assert.ok(activeDescendant, 'ArrowDown must highlight a real option')
  assert.equal(activeDescendant, optionDomId, 'ArrowDown must highlight the requested option')
  assert.equal(await control.command('getAttribute', option, { value: 'data-active' }), 'true')
  await pressFocusedIssueKey(control, search, 'Enter')
  await control.command('waitFor', testId(`${id}-menu`), { visible: false })
  assert.equal(await control.command('getAttribute', testId(id), { value: 'data-value' }), value)
  await control.command('waitFor', `${testId(id)}:focus`, { visible: true })
}

/** Resolve a real optimistic-lock conflict without overwriting a concurrent edit. */
export async function verifyIssueConflictRecovery(control, { request, reopen, captureScreenshot }) {
  const title = `Version conflict recovery ${process.pid}`
  await reopen()
  await control.command('fill', testId('independent-issue-title'), { value: title })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-actions'), { visible: true })
  const row = (await request('/api/v1/personal-issues?scope=created')).items.find(
    item => item.title === title
  )
  assert.ok(row)
  await control.command('clickWhenEnabled', testId('independent-issue-actions'))
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
  await control.command('waitFor', testId('independent-issue-actions'), { visible: true })
  await control.command('clickWhenEnabled', testId('independent-issue-actions'))
  await control.command('clickWhenEnabled', testId('independent-issue-edit'))
  assert.equal(
    await control.command('getValue', testId('independent-issue-description')),
    'Concurrent server edit'
  )
  await control.command('fill', testId('independent-issue-description'), {
    value: 'Explicitly revised after reload',
  })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-actions'), { visible: true })
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
  await pressFocusedIssueKey(control, picker, 'Escape')
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
    await pressFocusedIssueKey(control, preparation, 'Escape')
    await control.command('waitFor', preparation, { visible: false })
    await control.command('waitFor', picker, { visible: true })
    await pressFocusedIssueKey(control, picker, 'Escape')
    await control.command('waitFor', picker, { visible: false })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
  await control.command('scrollIntoView', trigger)
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', picker, { visible: true })
}

/** Recover an unsaved draft after the selected project is archived elsewhere. */
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
  await chooseIssueProperty(control, 'independent-issue-project', String(project.id), title)
  await request(
    `/api/v1/cloud-projects/${project.id}?version=${project.version}`,
    'DELETE',
    undefined,
    undefined,
    204
  )
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', `${testId('independent-issue-dialog')} [role="alert"]`, {
    visible: true,
  })
  const saved = (await request('/api/v1/personal-issues?scope=created')).items.filter(
    row => row.title === title
  )
  assert.equal(saved.length, 0, 'A failed project creation must roll back the Issue')
  const projectPicker = testId('independent-issue-project')
  await control.command('clickWhenEnabled', projectPicker)
  await control.command('clickWhenEnabled', testId('independent-issue-project-option-empty'))
  assert.equal(await control.command('getAttribute', projectPicker, { value: 'data-value' }), '')
  await control.command('fill', testId('independent-issue-title'), { value: `${title} recovered` })
  await control.command('clickWhenEnabled', testId('independent-issue-save'))
  await control.command('waitFor', testId('independent-issue-actions'), { visible: true })
  const remaining = (await request('/api/v1/personal-issues?scope=created')).items.filter(row =>
    row.title.startsWith(title)
  )
  assert.deepEqual(
    remaining.map(row => row.title),
    [`${title} recovered`],
    'Retrying the retained draft must create exactly one Issue'
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
    await control.command('fill', testId('independent-issue-search-people'), {
      value: 'draft search',
    })
    await control.command('waitFor', testId('independent-issue-search-people'), { visible: true })
    const expanded = await metrics('independent-issue-editor-actions')
    assert.ok(
      Math.abs(expanded.top - initial.top) <= 1,
      'Participant selection must not move the footer'
    )
    await pressFocusedIssueKey(control, testId('independent-issue-search-people'), 'Enter')
    const submitted = JSON.parse(
      await control.command('sampleElementPresence', testId('independent-issue-actions'), {
        value: '300',
      })
    )
    assert.equal(submitted.observed, false, 'Search Enter must not create an Issue')
    await pressFocusedIssueKey(control, testId('independent-issue-search-people'), 'Escape')
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
    // The document can restore its active element while the native window is in the background.
    await until(
      () => control.command('getActiveElementTestId', 'body'),
      activeId => activeId === 'collaboration-primary-create-issue',
      `Discarding the draft must return keyboard focus to ${opener}`,
      5_000
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
