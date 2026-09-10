import assert from 'node:assert/strict'
import { waitForSnapshot } from './conversation-layout.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

export async function verifyLocalBoardUnread(control, taskTabTestId) {
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('waitFor', '[data-testid="cloud-project-header-title"]', {
    text: '我的任务',
  })
  await control.command('markElementWithText', '[data-testid^="cloud-todo-card-drop-"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'local-unread-card',
  })
  const cardId = await control.command('getAttribute', '[data-e2e-anchor-id="local-unread-card"]', {
    value: 'data-testid',
  })
  assert.ok(cardId.startsWith('cloud-todo-card-drop-'))
  const itemId = cardId.slice('cloud-todo-card-drop-'.length)
  const cardSelector = `[data-testid="${cardId}"]`
  const unreadId = `cloud-todo-card-unread-${itemId}`
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(unreadId),
    'The completed local work item did not become unread'
  )
  const unreadClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(unreadClasses.split(' ').includes('bg-focus/10'))
  assert.ok(unreadClasses.split(' ').includes('border-focus/30'))
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-01-completed.png')

  await control.command('click', `[data-testid="cloud-todo-card-${itemId}"]`)
  await control.command('waitFor', '[data-testid="cloud-todo-detail"]', { visible: true })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(unreadId),
    'Opening the local work item did not clear its unread marker'
  )
  await captureVerificationScreenshot(control, 'local-board-unread-02-opened.png')
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('waitFor', cardSelector)
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(snapshot.testIds.includes(unreadId), false)
  const readClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(readClasses.split(' ').includes('bg-background'))
  assert.equal(readClasses.split(' ').includes('bg-focus/10'), false)
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-03-returned.png')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
}
