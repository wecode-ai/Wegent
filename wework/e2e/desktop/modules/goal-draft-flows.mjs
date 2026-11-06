import { waitForSnapshot } from './conversation-layout.mjs'
import { waitForBlankConversation } from './memory-tool-flows.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, assert } from './shared.mjs'

export async function setGoalDraftForTabTransfer(control, contentSelector) {
  await control.command('click', `${contentSelector} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', `${contentSelector} [data-testid="goal-draft-pill"]`)
}

export async function verifyTransferredGoalDraft(control, contentSelector) {
  await control.command('waitFor', `${contentSelector} [data-testid="goal-draft-pill"]`)
  await control.command('click', `${contentSelector} [data-testid="cancel-goal-draft-button"]`)
}

export async function verifyGoalDraftNavigation({ composerSelector, control, taskRowTestId }) {
  const pillSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="goal-draft-pill"]`
  const draft = 'Unsent goal draft retained across conversation navigation'
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', pillSelector)
  await control.command('fill', composerSelector, { value: draft })
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('goal-draft-pill'),
    'Goal draft mode leaked into a different conversation',
    undefined,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', pillSelector)
  assert.equal(await control.command('getValue', composerSelector), draft)
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="cancel-goal-draft-button"]`
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', composerSelector, { text: draft })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('goal-draft-pill'),
    'Cancelled goal draft mode returned after navigation',
    undefined,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(await control.command('getValue', composerSelector), draft)
  await control.command('fill', composerSelector, { value: '' })
}
