import {
  CREATED_INSTALLATION_ID,
  waitForElementCount,
  waitForManifestPlugin,
  exportedPackages,
  assertExportedPackage,
  waitForNewExport,
} from './harness-app-fixture.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, access } from 'node:fs/promises'
import { verifyDownloadedDshRuntimeCache } from './dsh-runtime-cache.mjs'
import { waitForEmbeddedBrowserVisibility } from './embedded-browser-visibility.mjs'

export async function verifyHarnessDevelopment(
  control,
  {
    uiTimeoutMs,
    resultDir,
    captureScreenshot,
    electronUserDataDirectory,
    legacyRuntimeCache,
    localDshPluginPath,
    downloadsPath,
  }
) {
  await control.command('click', '[data-testid="smart-apps-created-create"]')
  await control.command('waitFor', '[data-testid="smart-app-development-dialog"]', {
    text: '创建空白工作台',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('fill', '[data-testid="smart-app-development-display-name"]', {
    value: '空白 E2E 工作台',
  })
  await control.command(
    'waitFor',
    '[data-testid="smart-app-development-confirm"]:not([disabled])',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', '[data-testid="smart-app-development-advanced-toggle"]')
  await control.command('fill', '[data-testid="smart-app-development-name"]', {
    value: CREATED_INSTALLATION_ID,
  })
  await control.command('fill', '[data-testid="smart-app-development-parent-path"]', {
    value: resultDir,
  })
  await control.command('fill', '[data-testid="smart-app-development-description"]', {
    value: '验证 Web 预设、持续开发和文件夹运行',
  })
  await captureScreenshot(control, 'harness-apps-03a-create-web-preset.png', 'body')
  await control.command('clickWhenEnabled', '[data-testid="smart-app-development-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="chat-message-input"]', {
    text: '智能工作台开发助手',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
    text: 'DSH 开发预览',
    timeoutMs: uiTimeoutMs,
  })
  const initialPreviewText = await control.command(
    'getText',
    '[data-testid="smart-app-development-preview"]'
  )
  assert.ok(
    initialPreviewText.includes('正在准备运行环境和已配置插件') ||
      initialPreviewText.includes('文件改动后可重新加载'),
    `DSH development preview showed an unexpected initial state: ${initialPreviewText}`
  )
  assert.equal(initialPreviewText.includes('开始浏览'), false)
  assert.equal(initialPreviewText.includes('输入 URL 以打开页面'), false)
  await captureScreenshot(control, 'harness-apps-03b0-dsh-initial-state.png', 'body')
  await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
    text: '文件改动后可重新加载',
    timeoutMs: 120_000,
  })
  const blankWorkbenchSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const createdRoot = join(resultDir, CREATED_INSTALLATION_ID)
  const createdManifest = JSON.parse(
    await readFile(join(createdRoot, 'plugin-manifest.json'), 'utf8')
  )
  assert.equal(createdManifest.requirements.dsh, '0.2.0-rc.2')
  const createdBundle = JSON.parse(
    await readFile(join(createdRoot, createdManifest.entry.installPackage, 'package.json'), 'utf8')
  )
  assert.deepEqual(createdBundle.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer'])
  const currentInstallations = JSON.parse(
    await readFile(join(electronUserDataDirectory, 'harness-apps', 'installations.json'), 'utf8')
  )
  assert.equal(
    currentInstallations.find(item => item.manifest.name === CREATED_INSTALLATION_ID)
      ?.runtimeVersion,
    '0.2.0-rc.2',
    'A newly created Smart app must launch the current Workbench runtime'
  )
  assert.deepEqual(
    await verifyDownloadedDshRuntimeCache(join(resultDir, 'harness-runtime'), '0.1.0-rc.8'),
    legacyRuntimeCache,
    'Launching another app must preserve the verified legacy archive cache'
  )
  assert.equal(blankWorkbenchSnapshot.workbench?.currentProject, null)
  assert.equal(
    blankWorkbenchSnapshot.workbench?.standaloneWorkspacePath,
    join(resultDir, CREATED_INSTALLATION_ID)
  )
  const developmentTaskTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="task"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(
    developmentTaskTabTestId,
    'Smart app development preview did not expose its owning task tab'
  )
  const developmentTaskTabId = developmentTaskTabTestId.replace('workspace-tab-select-', '')
  const developmentPreviewSelector =
    `[data-testid="workspace-tab-content-${developmentTaskTabId}"] ` +
    '[data-testid="smart-app-development-preview"]'
  const developmentBrowserSelector =
    `${developmentPreviewSelector} ` + '[data-embedded-browser-label]'
  await control.command('waitFor', developmentBrowserSelector, {
    timeoutMs: uiTimeoutMs,
  })
  const developmentBrowserLabel = await control.command(
    'getAttribute',
    developmentBrowserSelector,
    { value: 'data-embedded-browser-label' }
  )
  assert.ok(
    developmentBrowserLabel,
    'Smart app development preview did not expose its native browser label'
  )
  await captureScreenshot(control, 'harness-apps-03b-builder-chat.png', 'body')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="smart-app-development-preview-reload"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const secondTaskStartedAt = Date.now()
  let secondTaskTabTestId = ''
  while (Date.now() - secondTaskStartedAt < uiTimeoutMs) {
    secondTaskTabTestId = await control.command(
      'getAttribute',
      '[data-tab-kind="task"][aria-selected="true"]',
      { value: 'data-testid' }
    )
    if (secondTaskTabTestId && secondTaskTabTestId !== developmentTaskTabTestId) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(
    secondTaskTabTestId && secondTaskTabTestId !== developmentTaskTabTestId,
    'Opening another task did not make the Smart app development task inactive'
  )
  const secondTaskTabId = secondTaskTabTestId.replace('workspace-tab-select-', '')
  await waitForElementCount(
    control,
    `[data-testid="workspace-tab-content-${secondTaskTabId}"] ` +
      '[data-testid="smart-app-development-preview"]',
    0,
    uiTimeoutMs,
    'The new task rendered the inactive Smart app development preview'
  )
  await waitForEmbeddedBrowserVisibility(
    control,
    developmentBrowserLabel,
    false,
    120_000,
    'The inactive Smart app preview did not restore a hidden native browser after reloading',
    developmentPreviewSelector
  )
  await captureScreenshot(control, 'harness-apps-03b2-preview-task-scoped.png', 'body')
  await control.command('click', `[data-testid="${developmentTaskTabTestId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="${developmentTaskTabTestId}"][aria-selected="true"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
    text: '文件改动后可重新加载',
    stableMs: 500,
    timeoutMs: 120_000,
  })
  await waitForEmbeddedBrowserVisibility(
    control,
    developmentBrowserLabel,
    true,
    uiTimeoutMs,
    'Returning to the Smart app development task did not restore its native browser',
    developmentPreviewSelector
  )
  const developmentBrowserTabSelector = '[role="tab"][data-testid^="right-workspace-browser-tab-"]'
  await control.command('waitFor', developmentBrowserTabSelector, {
    text: '空白 E2E 工作台',
    timeoutMs: uiTimeoutMs,
  })
  const developmentBrowserTabTestId = await control.command(
    'getAttribute',
    developmentBrowserTabSelector,
    { value: 'data-testid' }
  )
  assert.ok(
    developmentBrowserTabTestId,
    'The restored Smart app preview did not expose its right-workspace tab identity'
  )
  await control.command('waitFor', `[data-testid="${developmentBrowserTabTestId}-close-button"]`, {
    timeoutMs: uiTimeoutMs,
  })
  for (const action of ['add-plugins', 'refresh', 'reload']) {
    await control.command('waitFor', `[data-testid="smart-app-development-preview-${action}"]`, {
      enabled: true,
      timeoutMs: uiTimeoutMs,
    })
  }
  await control.command(
    'waitFor',
    '[data-testid="smart-app-development-preview-verification-unverified"]',
    {
      text: '尚未验证',
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'clickWhenEnabled',
    '[data-testid="smart-app-development-preview-verify"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'waitFor',
    '[data-testid="smart-app-development-preview-verification-passed"]',
    {
      text: '验证通过',
      timeoutMs: 120_000,
    }
  )
  await captureScreenshot(control, 'harness-apps-03b2-verification-passed.png', 'body')
  await control.command('click', `[data-testid="workspace-tab-close-${secondTaskTabId}"]`)
  await captureScreenshot(control, 'harness-apps-03b2-dsh-reloaded.png', 'body')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="smart-app-development-preview-add-plugins"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', '[data-testid="smart-app-plugin-dialog"]', {
    text: '添加 DSH 插件',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-03b3-add-plugin-dialog.png', 'body')
  await control.command('fill', '[data-testid="smart-app-plugin-spec-input"]', {
    value: localDshPluginPath,
  })
  await control.command('waitFor', '[data-testid="smart-app-plugin-confirm"]', {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('deferredClick', '[data-testid="smart-app-plugin-confirm"]')
  const linkedManifest = await waitForManifestPlugin(
    join(resultDir, CREATED_INSTALLATION_ID, 'plugin-manifest.json'),
    'file:plugins/wework-e2e-local-dsh-plugin',
    120_000
  )
  await waitForElementCount(
    control,
    '[data-testid="smart-app-plugin-dialog"]',
    0,
    120_000,
    'Smart app plugin dialog did not close after installation'
  )
  await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
    text: '文件改动后可重新加载',
    stableMs: 500,
    timeoutMs: 120_000,
  })
  await control.command(
    'waitFor',
    '[data-testid="smart-app-development-preview-verification-stale"]',
    {
      text: '验证已过期',
      timeoutMs: uiTimeoutMs,
    }
  )
  assert.deepEqual(linkedManifest.plugins, [
    {
      spec: 'file:plugins/wework-e2e-local-dsh-plugin',
      path: 'plugins/wework-e2e-local-dsh-plugin',
    },
  ])
  await access(
    join(resultDir, CREATED_INSTALLATION_ID, 'plugins/wework-e2e-local-dsh-plugin/cordis.patch.yml')
  )
  await captureScreenshot(control, 'harness-apps-03b4-plugin-reloaded.png', 'body')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="smart-app-development-preview-verify"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'waitFor',
    '[data-testid="smart-app-development-preview-verification-passed"]',
    {
      text: '验证通过',
      timeoutMs: 120_000,
    }
  )
  await captureScreenshot(control, 'harness-apps-03b4-verification-refreshed.png', 'body')
  const developmentWorkspaceTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(
    developmentWorkspaceTabId,
    'Smart app development page did not expose its workspace tab ID'
  )
  await control.command('click', `[data-testid="workspace-tab-close-${developmentWorkspaceTabId}"]`)
  await waitForElementCount(
    control,
    '[data-testid="smart-app-development-preview"]',
    0,
    uiTimeoutMs,
    'Closing the development workspace tab left its browser preview mounted'
  )
  await captureScreenshot(control, 'harness-apps-03b5-development-tab-closed.png', 'body')
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: 60_000,
  })
  await control.command(
    'waitFor',
    `[data-testid="smart-app-created-item-${CREATED_INSTALLATION_ID}"]`,
    {
      text: '空白 E2E 工作台',
      timeoutMs: uiTimeoutMs,
    }
  )
  await captureScreenshot(control, 'harness-apps-03c-linked-web-workbench.png', 'body')
  await control.command('click', `[data-testid="smart-app-actions-${CREATED_INSTALLATION_ID}"]`)
  await control.command(
    'waitFor',
    `[data-testid="smart-app-add-plugins-${CREATED_INSTALLATION_ID}"]`,
    {
      text: '添加 DSH 插件',
      timeoutMs: uiTimeoutMs,
    }
  )
  await captureScreenshot(control, 'harness-apps-03d-development-actions.png', 'body')
  await control.command(
    'waitFor',
    `[data-testid="smart-app-export-package-${CREATED_INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  const linkedExportsBefore = await exportedPackages(downloadsPath)
  await control.command(
    'click',
    `[data-testid="smart-app-export-package-${CREATED_INSTALLATION_ID}"]`
  )
  await control.command('waitFor', '[data-testid="smart-app-export-success"]', {
    text: '发布包已导出到下载目录。',
    timeoutMs: 120_000,
  })
  await assertExportedPackage({
    archivePath: await waitForNewExport(downloadsPath, linkedExportsBefore, uiTimeoutMs),
    expectedName: CREATED_INSTALLATION_ID,
    expectedVersion: '0.1.0',
    extractionPath: join(resultDir, 'linked-export-verification'),
  })
  await captureScreenshot(control, 'harness-apps-03f-linked-exported.png', 'body')
  await control.command('click', `[data-testid="smart-app-actions-${CREATED_INSTALLATION_ID}"]`)
  await control.command(
    'waitFor',
    `[data-testid="smart-app-remove-local-${CREATED_INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'click',
    `[data-testid="smart-app-remove-local-${CREATED_INSTALLATION_ID}"]`
  )
  await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await waitForElementCount(
    control,
    `[data-testid="smart-app-created-item-${CREATED_INSTALLATION_ID}"]`,
    0,
    uiTimeoutMs,
    'Unlinking an editable workbench left its card visible in My'
  )
  await access(join(resultDir, CREATED_INSTALLATION_ID, 'plugin-manifest.json'))
  await captureScreenshot(control, 'harness-apps-03g-linked-folder-preserved.png', 'body')
}
