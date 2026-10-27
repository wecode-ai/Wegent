import { waitForSnapshot } from './conversation-layout.mjs'
import { assert, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

const COLLAPSE_READ_SHORTCUT =
  process.platform === 'win32' ? 'Control+Alt+Shift+R' : 'Meta+Alt+Shift+R'

async function selectReadConversationAction(control, action) {
  await control.command('click', '[data-testid="runtime-task-view-menu-button"]')
  await control.command('click', `[data-testid="runtime-task-view-${action}"]`)
}

export async function verifyActiveConversationSurvivesCollapse({ control, taskId, state }) {
  const rowTestId = `runtime-local-task-row-${taskId}`
  const indicatorTestId = `runtime-local-task-${state}-${taskId}`
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      Boolean(snapshot.workbench) && snapshot.workbench.currentRuntimeTask?.taskId !== taskId,
    'The active collapse-read fixture must be a background task'
  )
  await control.command('waitFor', `[data-testid="${indicatorTestId}"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`runtime-local-task-unread-dot-${taskId}`),
    'The active collapse-read fixture must already be read'
  )

  await selectReadConversationAction(control, 'collapse-read')

  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(rowTestId) &&
      snapshot.testIds.includes(indicatorTestId) &&
      snapshot.testIds.includes('projects-section-toggle') &&
      !snapshot.testIds.includes('runtime-priority-section'),
    `Collapsing read conversations hid a ${state} task`
  )
}

export async function verifyCollapseReadConversations({
  composerSelector,
  control,
  expandGroupSelector,
  taskId,
}) {
  const rowTestId = `runtime-local-task-row-${taskId}`
  const rowSelector = `[data-testid="${rowTestId}"]`
  await control.command('waitFor', rowSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`runtime-local-task-unread-dot-${taskId}`),
    'The completed collapse-read fixture was not marked read'
  )

  const expectCurrentPreserved = async () => {
    await control.command('waitFor', rowSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await waitForWorkbenchDebugState(
      control,
      snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === taskId,
      'Collapsing read conversations changed the current task'
    )
    assert.equal(
      Number(await control.command('getElementCount', composerSelector)),
      1,
      'Collapsing read conversations closed the current composer'
    )
  }
  const expectCollapsed = async () => {
    await waitForSnapshot(
      control,
      snapshot =>
        !snapshot.testIds.includes(rowTestId) &&
        snapshot.testIds.includes('projects-section-toggle') &&
        snapshot.testIds.includes('runtime-chat-section-toggle') &&
        !snapshot.testIds.includes('runtime-priority-section'),
      'Collapsing read conversations did not preserve the grouped sidebar'
    )
    await waitForWorkbenchDebugState(
      control,
      snapshot => Boolean(snapshot.workbench) && snapshot.workbench.currentRuntimeTask == null,
      'Collapsing a background read conversation changed the current new task'
    )
    assert.equal(
      Number(await control.command('getElementCount', composerSelector)),
      1,
      'Collapsing read conversations closed the new-task composer'
    )
  }
  const expand = async (all = false) => {
    if (all) {
      await selectReadConversationAction(control, 'expand-read')
    } else {
      await control.command('click', expandGroupSelector)
    }
    await control.command('waitFor', rowSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  }

  await selectReadConversationAction(control, 'collapse-read')
  await expectCurrentPreserved()
  await control.command('press', composerSelector, { key: COLLAPSE_READ_SHORTCUT })
  await expectCurrentPreserved()

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForWorkbenchDebugState(
    control,
    snapshot => Boolean(snapshot.workbench) && snapshot.workbench.currentRuntimeTask == null,
    'The collapse-read fixture did not navigate away from the completed task'
  )
  await control.command('press', composerSelector, { key: COLLAPSE_READ_SHORTCUT })
  await expectCollapsed()
  await expand()
  await control.command('click', '[data-testid="runtime-priority-filter-button"]')
  await expectCollapsed()
  await expand()
  await selectReadConversationAction(control, 'collapse-read')
  await expectCollapsed()
  await expand(true)
  await control.command('click', rowSelector)
  await expectCurrentPreserved()

  // Restore the checkpoint's original primary action for subsequent scenarios.
  await selectReadConversationAction(control, 'priority')
  await control.command('click', '[data-testid="runtime-priority-filter-button"]')
  await control.command('waitFor', '[data-testid="projects-section-toggle"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}
