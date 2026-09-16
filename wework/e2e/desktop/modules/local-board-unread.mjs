import assert from 'node:assert/strict'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function waitForElementCount(control, selector, expected) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const actual = Number(await control.command('getElementCount', selector))
    if (actual === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(
    Number(await control.command('getElementCount', selector)),
    expected,
    `Unexpected element count for ${selector}`
  )
}

export async function verifyLocalBoardUnread(control, taskTabTestId) {
  const taskRowSelector = '[data-e2e-anchor-id="local-unread-runtime-task-row"]'
  await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
  await control.command(
    'waitFor',
    '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]'
  )
  await control.command('markElementWithText', '[data-testid^="runtime-local-task-row-"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'local-unread-runtime-task-row',
    visible: true,
  })
  await control.command('click', '[data-testid="task-my-work-button"]')
  await control.command('waitFor', '[data-testid="cloud-project-header-title"]', {
    text: '我的任务',
    visible: true,
  })
  const cardId = await control.command(
    'markElementWithText',
    '[data-testid^="cloud-todo-card-drop-"]',
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      value: 'local-unread-card',
      visible: true,
    }
  )
  assert.ok(cardId.startsWith('cloud-todo-card-drop-'))
  const itemId = cardId.slice('cloud-todo-card-drop-'.length)
  const cardSelector = '[data-e2e-anchor-id="local-unread-card"]'
  const unreadId = `cloud-todo-card-unread-${itemId}`
  const unreadSelector = `${cardSelector} [data-testid="${unreadId}"]`
  await control.command('waitFor', unreadSelector)
  const unreadClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(unreadClasses.split(' ').includes('bg-focus/10'))
  assert.ok(unreadClasses.split(' ').includes('border-focus/30'))
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-01-completed.png')

  await control.command('click', `${cardSelector} [data-testid="cloud-todo-card-${itemId}"]`)
  await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
    visible: true,
  })
  await waitForElementCount(control, unreadSelector, 0)
  await captureVerificationScreenshot(control, 'local-board-unread-02-opened.png')
  await control.command('click', '[data-testid="cloud-todo-detail-close"]', { visible: true })
  await control.command('click', taskRowSelector)
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
  })
  await control.command('click', '[data-testid="task-my-work-button"]')
  await control.command('markElementWithText', '[data-testid^="cloud-todo-card-drop-"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'local-unread-card',
    visible: true,
  })
  await control.command('waitFor', cardSelector)
  await waitForElementCount(control, unreadSelector, 0)
  const readClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(readClasses.split(' ').includes('bg-background'))
  assert.equal(readClasses.split(' ').includes('bg-focus/10'), false)
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-03-returned.png')
  await control.command('markElementWithText', '[data-testid^="runtime-local-task-row-"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'local-unread-runtime-task-row',
    visible: true,
  })
  await control.command('click', taskRowSelector)
  await control.command('waitFor', `[data-testid="${taskTabTestId}"][aria-selected="true"]`)
}
