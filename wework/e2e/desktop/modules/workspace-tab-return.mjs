import assert from 'node:assert/strict'
import { waitForSnapshot } from './conversation-layout.mjs'
import { DEFAULT_STEP_TIMEOUT_MS, WORKBENCH_READY_TIMEOUT_MS, withTimeout } from './shared.mjs'

async function returnTab(control, detached, tabId, draft, waitForDraft) {
  const selector = `[data-testid="workspace-tab-select-${tabId}"]`
  const composer = `[data-testid="workspace-tab-content-${tabId}"] [data-testid="chat-message-input"]`
  await detached.command('waitFor', composer, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await detached.command('fill', composer, { value: draft })
  await waitForDraft(
    detached,
    draft,
    'The source composer did not commit its draft before transfer'
  )
  await detached.command('contextMenu', selector)
  await detached.command('click', '[data-testid="workspace-tab-return-to-main"]')
  control.activateWindow('main')
  await control.command('waitFor', selector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await control.command('waitFor', composer, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  assert.equal(await control.command('getValue', composer), draft)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.filter(id => id === `workspace-tab-${tabId}`).length === 1,
    'Returning the tab duplicated its identity'
  )
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let windows
  do {
    windows = JSON.parse(await control.command('getWindowFocusSnapshot', 'body')).workspaceWindows
    if (!windows.length) return
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`Returning the last tab did not close its window: ${JSON.stringify(windows)}`)
}

export async function verifyWorkspaceTabReturn(control, detached, tabId, waitForDraft) {
  await returnTab(control, detached, tabId, '普通标签页移回后保留的草稿', waitForDraft)
  const selector = `[data-testid="workspace-tab-select-${tabId}"]`
  await control.command('contextMenu', selector)
  await control.command('click', '[data-testid="workspace-tab-pin"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`workspace-tab-close-${tabId}`),
    'The returned tab did not become fixed'
  )
  await control.command('contextMenu', selector)
  const readyCount = control.readyCount
  await control.command('click', '[data-testid="workspace-tab-open-new-window"]')
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The fixed tab window did not connect'
  )
  const fixedWindow = { command: (...args) => control.commandForWindow(ready.windowLabel, ...args) }
  await fixedWindow.command('waitFor', selector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await returnTab(control, fixedWindow, tabId, '固定标签页移回后保留的草稿', waitForDraft)
  assert.equal(
    Number(
      await control.command('getElementCount', `[data-testid="workspace-tab-close-${tabId}"]`)
    ),
    0
  )
  const beforeRestart = control.readyCount
  await control.command('restartCoreDsh', 'body')
  await withTimeout(
    control.awaitReadyAfter(beforeRestart),
    WORKBENCH_READY_TIMEOUT_MS,
    'Main window did not restart'
  )
  control.activateWindow('main')
  await control.command('waitFor', selector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  const windows = JSON.parse(
    await control.command('getWindowFocusSnapshot', 'body')
  ).workspaceWindows
  assert.equal(
    windows.length,
    0,
    'The returned fixed tab reopened in a detached window after restart'
  )
  await control.command('contextMenu', selector)
  await control.command('click', '[data-testid="workspace-tab-unpin"]')
}
