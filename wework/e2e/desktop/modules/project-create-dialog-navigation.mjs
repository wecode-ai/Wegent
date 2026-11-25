const DIALOG = '[data-testid="collaboration-project-create-dialog"]'

export async function confirmProjectDraftDiscard(control) {
  const discard = `${DIALOG} [data-testid="collaboration-project-create-discard"]`
  await control.command('waitFor', discard, { visible: true })
  await control.command(
    'clickWhenEnabled',
    `${discard} [data-testid="collaboration-project-create-discard-confirm"]`
  )
}

export async function waitForProjectCreateClosed(control, content, timeoutMs) {
  // Hidden configuration forms are still mounted until creation or discard completes.
  await control.command('waitFor', `${content}:not(:has(${DIALOG}))`, { timeoutMs })
}
