import assert from 'node:assert/strict'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

const BOTTOM_PANEL_SELECTOR = '[data-testid="bottom-workspace-panel"]'
const BOTTOM_PANEL_TOGGLE_SELECTOR = '[data-testid="toggle-bottom-workspace-panel-button"]'
const LOCAL_TERMINAL_SELECTOR = '[data-testid="embedded-local-terminal"]'
const TERMINAL_PRESERVATION_MARKER = 'WEWORK_LOCAL_BOARD_TERMINAL_PRESERVED'

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

async function ensureLocalTerminalOpen(control) {
  const bottomPanelCount = Number(await control.command('getElementCount', BOTTOM_PANEL_SELECTOR))
  const bottomPanelOpen =
    bottomPanelCount > 0 &&
    (await control.command('getAttribute', BOTTOM_PANEL_SELECTOR, {
      value: 'aria-hidden',
    })) === 'false'
  if (!bottomPanelOpen) {
    await control.command('click', BOTTOM_PANEL_TOGGLE_SELECTOR, { visible: true })
  }
  await control.command('waitFor', LOCAL_TERMINAL_SELECTOR, {
    visible: true,
  })
}

async function assertLocalTerminalPreserved(control, sessionId, stage) {
  await control.command('waitFor', LOCAL_TERMINAL_SELECTOR, {
    visible: true,
  })
  assert.equal(
    await control.command('getAttribute', LOCAL_TERMINAL_SELECTOR, {
      value: 'data-session-id',
    }),
    sessionId,
    `The local task terminal session changed ${stage}`
  )
  assert.match(
    await control.command('getTerminalText', LOCAL_TERMINAL_SELECTOR),
    new RegExp(TERMINAL_PRESERVATION_MARKER),
    `The local task terminal buffer was lost ${stage}`
  )
}

export async function verifyLocalBoardUnread(control, taskTabTestId) {
  const boardButtonSelector = '[data-testid="runtime-priority-filter-button"][aria-label="看板"]'
  const boardSurfaceSelector = '[data-testid="task-view-board-transition"]'
  await control.command('click', `[data-testid="${taskTabTestId}"]`, { visible: true })
  await control.command('waitFor', `[data-testid="${taskTabTestId}"][aria-selected="true"]`)
  await ensureLocalTerminalOpen(control)
  const terminalSessionId = await control.command('getAttribute', LOCAL_TERMINAL_SELECTOR, {
    value: 'data-session-id',
  })
  assert.ok(terminalSessionId, 'The local task terminal did not expose its session ID')
  await control.command('terminalInput', LOCAL_TERMINAL_SELECTOR, {
    value: `printf '${TERMINAL_PRESERVATION_MARKER}\\n'\r`,
  })
  await control.command(
    'waitFor',
    `${LOCAL_TERMINAL_SELECTOR} .xterm-accessibility-tree [role="listitem"]`,
    {
      text: TERMINAL_PRESERVATION_MARKER,
    }
  )
  await control.command('click', boardButtonSelector, { visible: true })
  await control.command('waitFor', boardSurfaceSelector, {
    visible: true,
  })
  const cardId = await control.command(
    'markElementWithText',
    `${boardSurfaceSelector} [data-testid^="cloud-todo-card-drop-"]`,
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      value: 'local-unread-card',
      visible: true,
    }
  )
  assert.ok(cardId.startsWith('cloud-todo-card-drop-'))
  const itemId = cardId.slice('cloud-todo-card-drop-'.length)
  const cardSelector = `${boardSurfaceSelector} [data-testid="${cardId}"]`
  const unreadId = `cloud-todo-card-unread-${itemId}`
  const unreadSelector = `${cardSelector} [data-testid="${unreadId}"]`
  await control.command('waitFor', unreadSelector)
  const unreadClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(unreadClasses.split(' ').includes('bg-focus/10'))
  assert.ok(unreadClasses.split(' ').includes('border-focus/30'))
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-01-completed.png')

  await control.command('click', `${cardSelector} [data-testid="cloud-todo-card-${itemId}"]`)
  await control.command('waitFor', boardSurfaceSelector, {
    visible: false,
  })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
  })
  await assertLocalTerminalPreserved(
    control,
    terminalSessionId,
    'after opening the task from board'
  )
  await captureVerificationScreenshot(control, 'local-board-unread-02-opened.png')
  await control.command('click', boardButtonSelector, { visible: true })
  await control.command('waitFor', boardSurfaceSelector, {
    visible: true,
  })
  await control.command('waitFor', cardSelector)
  await waitForElementCount(control, unreadSelector, 0)
  const readClasses = await control.command('getAttribute', cardSelector, { value: 'class' })
  assert.ok(readClasses.split(' ').includes('bg-background'))
  assert.equal(readClasses.split(' ').includes('bg-focus/10'), false)
  await control.command('scrollIntoView', cardSelector)
  await captureVerificationScreenshot(control, 'local-board-unread-03-returned.png')
  await control.command('click', boardButtonSelector, { visible: true })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
  })
  await assertLocalTerminalPreserved(control, terminalSessionId, 'after toggling back from board')
}
