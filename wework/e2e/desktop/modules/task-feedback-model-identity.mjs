import assert from 'node:assert/strict'

export async function assertFeedbackModelSnapshot(control, identity, expectedModelName) {
  await control.command('clickWhenEnabled', '[data-testid="topnav-feedback-button"]')
  try {
    await control.command('waitFor', '[data-testid="task-feedback-note"]', { visible: true })
    await control.command('fill', '[data-testid="task-feedback-note"]', {
      value: 'Inspect the saved and restored task model identities.',
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="task-feedback-group-full-task-checkbox"]'
    )
    await control.command('clickWhenEnabled', '[data-testid="task-feedback-export-button"]')
    await control.command('waitFor', '[data-testid="task-feedback-preview-list"]')
    await control.command('clickWhenEnabled', '[data-testid="task-feedback-preview-category-task"]')
    await control.command(
      'clickWhenEnabled',
      '[data-testid="task-feedback-preview-entry-context/task.json"]'
    )
    await control.command('waitFor', '[data-testid="task-feedback-preview-content"]')
    const context = JSON.parse(
      await control.command('getText', '[data-testid="task-feedback-preview-content"]')
    )
    assert.equal(context.task.taskId, identity.taskId)
    assert.equal(typeof context.modelSelection?.scopeFingerprint, 'number')
    for (const source of ['configured', 'effective', 'selected']) {
      assert.equal(
        context.modelSelection[source]?.modelName,
        expectedModelName,
        `The feedback preview omitted the ${source} task model identity`
      )
      assert.equal(Object.hasOwn(context.modelSelection[source], 'options'), false)
    }
  } finally {
    await control.command('clickWhenEnabled', '[data-testid="task-feedback-close-button"]')
    await control.command('waitFor', '[data-testid="task-feedback-dialog-overlay"]', {
      visible: false,
    })
  }
}
