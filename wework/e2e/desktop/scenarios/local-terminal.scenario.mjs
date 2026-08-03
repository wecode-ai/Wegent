import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const TERMINAL_CARD_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-terminal-card"]`
const EMBEDDED_TERMINAL_SELECTOR = '[data-testid="embedded-local-terminal"]'
const BOTTOM_TERMINAL_TAB_SELECTOR = '[data-testid="bottom-workspace-terminal-tab"]'

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'local-terminal-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'local-terminal-e2e',
    timeoutMs,
  })
}

export function createDesktopScenario({
  captureScreenshot,
  standalone,
  uiTimeoutMs,
  workspacePath,
}) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  return {
    async handleHttp() {
      return false
    },

    async verify(control) {
      if (standalone) {
        await createLocalProject(control, workspacePath, uiTimeoutMs)
      }

      await control.command('waitFor', TERMINAL_CARD_SELECTOR, { timeoutMs: uiTimeoutMs })
      await capture(control, 'local-terminal-00-card-visible.png')
      await control.command('click', TERMINAL_CARD_SELECTOR)

      await control.command('waitFor', EMBEDDED_TERMINAL_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', BOTTOM_TERMINAL_TAB_SELECTOR, { timeoutMs: uiTimeoutMs })
      await capture(control, 'local-terminal-01-session-started.png')

      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        snapshot.testIds.includes('embedded-local-terminal'),
        'The embedded local terminal element was not rendered'
      )
    },

    diagnostics() {
      return {}
    },
  }
}
