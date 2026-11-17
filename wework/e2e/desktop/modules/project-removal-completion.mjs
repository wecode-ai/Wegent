import { waitForSnapshot } from './conversation-layout.mjs'
import { ACTIVE_COMPOSER_SELECTOR, assert } from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

export async function verifyProjectRemovalCompletion(control, projectId, workspacePath) {
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes(`project-menu-${projectId}`) &&
      !snapshot.testIds.includes(`remove-project-dialog-${projectId}-overlay`),
    'Confirmed cloud project removal left its project row or modal overlay blocking the workbench'
  )
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench != null &&
      String(snapshot.workbench.currentProject?.id) !== projectId &&
      snapshot.workbench.standaloneWorkspacePath !== workspacePath,
    'Confirmed cloud project removal retained the active project or standalone workspace'
  )

  await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
  const draft = 'The workbench remains interactive after cloud project removal'
  try {
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: draft })
    assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), draft)
  } finally {
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
  }
}
