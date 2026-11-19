export async function confirmProjectDraftDiscard(control) {
  const discard =
    '[data-testid="collaboration-project-create-dialog"] [data-testid="collaboration-project-create-discard"]'
  await control.command('waitFor', discard, { visible: true })
  await control.command(
    'clickWhenEnabled',
    `${discard} [data-testid="collaboration-project-create-discard-confirm"]`
  )
}
