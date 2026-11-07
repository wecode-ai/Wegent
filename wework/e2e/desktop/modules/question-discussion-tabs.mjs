import assert from 'node:assert/strict'
import { ACTIVE_COMPOSER_SELECTOR, ACTIVE_WORKBENCH_SELECTOR, selectE2EModel } from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

export const OTHER_TASK_PROMPT = '讨论标签页隔离：请只回复另一个任务已就绪。'
export const OTHER_TASK_REPLY = '另一个任务已就绪。'

/** Exercise task-owned tabs with real navigation, storage and independent runtime tasks. */
export async function verifyQuestionDiscussionTabs({
  control,
  source,
  dialog,
  composer,
  draft,
  captureScreenshot,
}) {
  const tab =
    '[data-testid="titlebar-right-panel"] [role="tab"][data-testid^="right-workspace-discussion-tab-"]'
  const browser =
    '[data-testid="titlebar-right-panel"] [role="tab"][data-testid^="right-workspace-browser-tab-"]'
  await control.command('waitFor', `${tab}[aria-selected="true"]`, { visible: true })
  await control.command('waitFor', browser, { visible: true })
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('waitFor', dialog, { visible: false })
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('waitFor', dialog, { visible: true })
  assert.equal(await control.command('getValue', composer), draft)

  await control.command('click', '[data-testid="new-chat-button"]')
  await selectE2EModel(control)
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: OTHER_TASK_PROMPT })
  await control.command(
    'clickWhenEnabled',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: OTHER_TASK_REPLY,
      visible: true,
    }
  )
  const other = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.pane?.currentRuntimeTask?.taskId &&
      snapshot.pane.currentRuntimeTask.taskId !== source.taskId &&
      !snapshot.pane.status.isBusy,
    'The second task must be independent of the discussion source'
  )
  const otherId = other.pane.currentRuntimeTask.taskId
  await control.command('waitFor', dialog, { visible: false })
  await control.command('waitFor', tab, { visible: false })
  await captureScreenshot(control, 'question-discussion-tabs-other-task.png', 'body')

  const openTask = taskId =>
    control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
  await openTask(source.taskId)
  await control.command('waitFor', composer, { visible: true })
  assert.equal(await control.command('getValue', composer), draft)
  await control.command('click', browser)
  await control.command('waitFor', `${browser}[aria-selected="true"]`, { visible: true })
  await control.command('waitFor', dialog, { visible: false })
  await openTask(otherId)
  await control.command('waitFor', dialog, { visible: false })
  await openTask(source.taskId)
  await control.command('waitFor', `${browser}[aria-selected="true"]`, { visible: true })
  await control.command('waitFor', dialog, { visible: false })
  await control.command('click', tab)
  await control.command('waitFor', composer, { visible: true })
  assert.equal(await control.command('getValue', composer), draft)
  await captureScreenshot(control, 'question-discussion-tabs-restored-draft.png', 'body')
}
