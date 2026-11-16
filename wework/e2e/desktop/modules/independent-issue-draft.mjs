import assert from 'node:assert/strict'

const testId = id => `[data-testid="${id}"]`

/** Verify draft safety and bounded layout without creating an Issue. */
export async function verifyIndependentIssueDraft(control, { request, reopen, captureScreenshot }) {
  const before = await request('/api/v1/personal-issues?scope=created')
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1100, height: 700 }),
  })
  const title = 'Unsaved Issue keyboard regression'
  const description = 'Keep the draft until an explicit discard.'
  const metrics = async id => JSON.parse(await control.command('getElementMetrics', testId(id)))[0]
  try {
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
