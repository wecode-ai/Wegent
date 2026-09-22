import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

async function findTreeItem(control, name, timeoutMs, rootSelector = '') {
  const selector = `${rootSelector ? `${rootSelector} ` : ''}${FILE_TREE_ITEM_SELECTOR}[aria-label="${name}"]`
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

async function waitForFileContent(filePath, expectedContent, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await readFile(filePath, 'utf8')) === expectedContent) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for autosaved content in "${filePath}"`)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  return {
    async verify(control) {
      const breadcrumbDirectory = join(workspacePath, 'breadcrumb-fixture')
      await mkdir(breadcrumbDirectory, { recursive: true })
      await writeFile(join(breadcrumbDirectory, 'first.ts'), 'export const first = 1\n')
      await writeFile(join(breadcrumbDirectory, 'second.ts'), 'export const second = 2\n')
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
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
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

      await control.command('waitFor', '[data-testid="workspace-file-editor"][data-theme="dark"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const authenticated = true',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getText', '[data-testid="workspace-file-path"]'),
        join(workspacePath, 'auth.ts'),
        'The second local file did not replace the retained preview after loading'
      )
      await captureScreenshot(control, 'local-file-preview-01-dark-editor.png', 'body')
      await control.command('contextMenu', '[data-testid="workspace-file-name-button"]')
      await control.command('waitFor', '[data-testid="workspace-file-context-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      if (
        Number(
          await control.command('getElementCount', '[data-testid="workspace-file-open-with"]')
        ) > 0
      ) {
        await control.command('click', '[data-testid="workspace-file-open-with"]')
        await control.command('waitFor', '[data-testid="workspace-file-open-with-submenu"]', {
          timeoutMs: uiTimeoutMs,
        })
        assert.ok(
          Number(
            await control.command(
              'getElementCount',
              '[data-testid="workspace-file-open-with-submenu"] [role="menuitem"]'
            )
          ) > 0,
          'The file context menu did not expose any installed application'
        )
      }
      await control.command('press', 'body', { key: 'Escape' })
      await waitForMissing(control, '[data-testid="workspace-file-open-with-submenu"]', uiTimeoutMs)
      await control.command('press', 'body', { key: 'Escape' })
      await waitForMissing(control, '[data-testid="workspace-file-context-menu"]', uiTimeoutMs)
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="workspace-file-save-button"]')
        ),
        0,
        'Writable text files exposed a manual save button instead of autosaving'
      )
      await control.command('fill', '[data-testid="workspace-file-editor"] .cm-content', {
        value: 'export const authenticated = false\n',
      })
      await waitForFileContent(
        join(workspacePath, 'auth.ts'),
        'export const authenticated = false',
        uiTimeoutMs
      )
      await waitForMissing(control, '[data-testid="workspace-file-saving-status"]', uiTimeoutMs)
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="workspace-file-save-error"]')
        ),
        0,
        'Autosaving the edited file displayed an unexpected save error'
      )
      await captureScreenshot(control, 'local-file-preview-02-dark-autosaved.png', 'body')
      await control.command('click', '[data-testid="workspace-file-toggle-tree-button"]')
      const rootBreadcrumb = `[data-testid=${JSON.stringify(
        `workspace-file-breadcrumb-${workspacePath.replace(/\\/g, '/')}`
      )}]`
      await control.command('click', rootBreadcrumb)
      await control.command('waitFor', '[data-testid="workspace-file-directory-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      const directoryMenuSelector = '[data-testid="workspace-file-directory-menu"]'
      const directorySelector = await findTreeItem(
        control,
        'breadcrumb-fixture',
        uiTimeoutMs,
        directoryMenuSelector
      )
      await control.command('click', directorySelector)
      const firstFileSelector = await findTreeItem(
        control,
        'first.ts',
        uiTimeoutMs,
        directoryMenuSelector
      )
      await control.command('click', directorySelector)
      await waitForMissing(control, firstFileSelector, uiTimeoutMs)
      await control.command('click', directorySelector)
      await control.command('waitFor', firstFileSelector, { timeoutMs: uiTimeoutMs })
      await control.command('click', firstFileSelector)
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const first = 1',
        timeoutMs: uiTimeoutMs,
      })
      await waitForMissing(control, '[data-testid="workspace-file-directory-menu"]', uiTimeoutMs)
      const fileTabsSelector = '[role="tab"][data-testid^="right-workspace-file-tab"]'
      await control.command('waitFor', '[data-testid="right-workspace-file-tab"]', {
        text: 'auth.ts',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${fileTabsSelector}[aria-selected="true"]`, {
        text: 'first.ts',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${fileTabsSelector} [data-file-icon="typescript"] path`
          )
        ) > 0,
        true,
        'File tabs must render their file-type icons'
      )
      assert.equal(
        Number(await control.command('getElementCount', fileTabsSelector)),
        2,
        'Selecting a dropdown file must retain the previous file tab'
      )
      await control.command('click', '[data-testid="workspace-file-name-button"]')
      await control.command('click', await findTreeItem(control, 'second.ts', uiTimeoutMs))
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const second = 2',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', fileTabsSelector)),
        3,
        'Selecting another file must open another file tab'
      )
      await control.command('click', rootBreadcrumb)
      await control.command('click', await findTreeItem(control, 'auth.ts', uiTimeoutMs))
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const authenticated = false',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', fileTabsSelector)),
        3,
        'Selecting an already-open file must reuse its existing tab'
      )
      await control.command('click', `${fileTabsSelector}[title$="first.ts"]`)
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const first = 1',
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${FILE_TREE_ITEM_SELECTOR}[aria-label="first.ts"][data-item-selected="true"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('click', `${fileTabsSelector}[title$="second.ts"]`)
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: 'export const second = 2',
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${FILE_TREE_ITEM_SELECTOR}[aria-label="second.ts"][data-item-selected="true"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        `${fileTabsSelector}[title$="second.ts"] [data-testid$="-close-button"]`
      )
      await waitForMissing(control, `${fileTabsSelector}[title$="second.ts"]`, uiTimeoutMs)
      assert.equal(Number(await control.command('getElementCount', fileTabsSelector)), 2)
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
      await captureScreenshot(control, 'local-file-preview-03-dark-review.png', 'body')
    },
  }
}
