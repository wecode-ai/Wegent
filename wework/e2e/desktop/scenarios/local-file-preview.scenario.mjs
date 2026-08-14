import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const FILE_TREE_ITEM_SELECTOR = 'button[data-type="item"]'

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('waitFor', '[data-testid="project-work-button"]', { timeoutMs })
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
    value: 'local-file-preview-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'local-file-preview-e2e',
    timeoutMs,
  })
}

async function findTreeItem(control, name, timeoutMs) {
  const selector = `${FILE_TREE_ITEM_SELECTOR}[aria-label="${name}"]`
  await control.command('waitFor', selector, { timeoutMs })
  return selector
}

async function waitForMissing(control, selector, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const count = Number(await control.command('getElementCount', selector))
    if (count === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for "${selector}" to disappear`)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  return {
    async verify(control) {
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('navigate', 'body', { value: '/' })
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('waitFor', '[data-testid="right-workspace-file-option"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="right-workspace-file-option"]')
      await control.command('waitFor', '[data-testid="workspace-file-tree-pierre"]', {
        timeoutMs: uiTimeoutMs,
      })

      const readmeSelector = await findTreeItem(control, 'README.md', uiTimeoutMs)
      await control.command('click', readmeSelector)
      await control.command('waitFor', '[data-testid="workspace-markdown-preview"]', {
        text: 'Desktop E2E workspace',
        timeoutMs: uiTimeoutMs,
      })

      const authSelector = await findTreeItem(control, 'auth.ts', uiTimeoutMs)
      await control.command('click', authSelector)
      await control.command('waitFor', '[data-testid="workspace-file-preview-loading-indicator"]', {
        timeoutMs: uiTimeoutMs,
      })
      const switchingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        !switchingSnapshot.testIds.includes('workspace-file-preview-progress'),
        'Switching local files replaced the current preview with the full loading page'
      )
      assert.match(
        switchingSnapshot.text,
        /Desktop E2E workspace/,
        'Switching local files cleared the current preview before the next file loaded'
      )

      await control.command(
        'waitFor',
        '[data-testid="workspace-file-preview-code-view"][data-theme="dark"]',
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        await control.command('getText', '[data-testid="workspace-file-path"]'),
        join(workspacePath, 'auth.ts'),
        'The second local file did not replace the retained preview after loading'
      )
      await control.command('click', '[data-testid="workspace-file-edit-button"]')
      await control.command('waitFor', '[data-testid="workspace-file-editor"][data-theme="dark"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'local-file-preview-01-dark-editor.png', 'body')
      await control.command('fill', '[data-testid="workspace-file-editor"] .cm-content', {
        value: 'export const authenticated = false\n',
      })
      await writeFile(
        join(workspacePath, 'auth.ts'),
        'export const authenticated = false\n// changed outside Wework\n'
      )
      await control.command('clickWhenEnabled', '[data-testid="workspace-file-save-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workspace-file-save-error"]', {
        text: 'changed on disk',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workspace-file-conflict-reload-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-file-conflict-reload-button"]')
      await control.command('waitFor', '[data-testid="workspace-file-preview-loading-indicator"]', {
        timeoutMs: uiTimeoutMs,
      })
      await waitForMissing(
        control,
        '[data-testid="workspace-file-preview-loading-indicator"]',
        uiTimeoutMs
      )
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('clickWhenEnabled', '[data-testid="right-workspace-review-option"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        '[data-testid="file-changes-review-panel"][data-theme="dark"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        '[data-testid="file-changes-review-file-diff-body"][data-theme="dark"]',
        { timeoutMs: uiTimeoutMs }
      )
      await captureScreenshot(control, 'local-file-preview-02-dark-review.png', 'body')
    },
  }
}
