import { waitForSnapshot } from './conversation-layout.mjs'
import { assert, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export async function verifyNewTaskBoardAssociation(control, projectName, issueTitle) {
  const before = JSON.parse(await control.command('snapshot', 'body'))
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const opened = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        id => id.startsWith('workspace-tab-task-') && !before.testIds.includes(id)
      ),
    'Opening a new draft did not create a task tab'
  )
  const tab = opened.testIds.find(
    id => id.startsWith('workspace-tab-task-') && !before.testIds.includes(id)
  )
  assert.ok(tab, 'The new draft task tab was not found')
  const content = `[data-testid="workspace-tab-content-${tab.slice('workspace-tab-'.length)}"]`
  const chooseProject = async () => {
    await control.command('click', `${content} [data-testid="project-space-context-pill"]`)
    await control.command(
      'markElementWithText',
      '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
      { text: projectName, value: 'draft-target-project', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('click', '[data-e2e-anchor-id="draft-target-project"]')
    await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
      text: projectName,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }

  await control.command('waitFor', `${content} [data-testid="chat-message-input"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await chooseProject()
  await control.command('click', '[data-testid="task-board-association-close"]')
  await chooseProject()
  await control.command('click', '[data-testid="task-board-association-create"]')
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await chooseProject()
  await control.command(
    'markElementWithText',
    '[data-testid="task-board-association-dialog"] [data-testid^="task-board-association-item-"]',
    { text: issueTitle, value: 'draft-target-issue', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('click', '[data-e2e-anchor-id="draft-target-issue"]')
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="transient-notice"]', {
    text: issueTitle,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(await control.command('getElementCount', `${content} [data-testid="message-user"]`)),
    0,
    'Selecting a draft Issue sent a user message'
  )
  await control.command('click', `${content} [data-testid="project-space-context-pill"]`)
  await control.command('click', '[data-testid="clear-project-space-context-button"]')
  await control.command(
    'click',
    `[data-testid="workspace-tab-close-${tab.slice('workspace-tab-'.length)}"]`
  )
}
