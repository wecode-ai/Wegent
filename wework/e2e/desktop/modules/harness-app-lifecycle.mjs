import { pathToFileURL } from 'node:url'
import {
  INSTALLATION_ID,
  IMPORTED_INSTALLATION_ID,
  waitForMissing,
  exportedPackages,
  assertExportedPackage,
  waitForNewExport,
  MODEL_LABEL,
  APP_ROUTE,
  waitForElementCount,
  setExperimentalFeatures,
} from './harness-app-fixture.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { verifyDownloadedDshRuntimeCache } from './dsh-runtime-cache.mjs'
import { telemetryEvents } from './response-protocol.mjs'
import { verifySmartAppMarketplaceIdentity } from './smart-app-marketplace-identity.mjs'

export async function verifyHarnessLifecycle(
  control,
  {
    packagePath,
    uiTimeoutMs,
    captureScreenshot,
    importedPackagePath,
    sharedSmartAppId,
    ownerRequest,
    downloadsPath,
    resultDir,
    legacyRuntimeCache,
  }
) {
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(packagePath).href,
        name: 'dsh-e2e-smoke.zip',
        mimeType: 'application/zip',
      },
    ]),
  })
  await control.command('waitFor', `[data-testid="smart-app-created-item-${INSTALLATION_ID}"]`, {
    text: 'DSH E2E Smoke 0.1.0-rc.8',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-04-created.png', 'body')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="smart-app-created-publish-${INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', '[data-testid="smart-app-publish-dialog"]', {
    text: '选择文件',
    timeoutMs: uiTimeoutMs,
  })
  const publishDialogText = await control.command(
    'getText',
    '[data-testid="smart-app-publish-dialog"]'
  )
  assert.ok(
    publishDialogText.includes('未选择文件'),
    'Smart app publish dialog did not show the localized empty file state'
  )
  assert.ok(
    !publishDialogText.includes('Choose File') && !publishDialogText.includes('no file selected'),
    'Smart app publish dialog leaked native English file picker text'
  )
  assert.ok(
    publishDialogText.includes('将使用已导入的发布包') && publishDialogText.includes('关联文件夹'),
    'Smart app publish dialog did not explain the imported release package flow'
  )
  await captureScreenshot(control, 'harness-apps-04a-publish-dialog-zh.png', 'body')
  await control.command('click', '[data-testid="smart-app-publish-close"]')
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(importedPackagePath).href,
        name: 'dsh-e2e-smoke-imported.zip',
        mimeType: 'application/zip',
      },
    ]),
  })
  await control.command(
    'waitFor',
    `[data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
    {
      text: 'DSH E2E Smoke 0.1.0-rc.8',
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', '[data-testid="smart-apps-import-button"]', {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-apps-section-owned"]', {
    text: '我的',
    timeoutMs: uiTimeoutMs,
  })
  const harnessManagementSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    harnessManagementSnapshot.location.includes('app_type=smart_app') &&
      harnessManagementSnapshot.location.includes('view=owned'),
    `My Smart apps did not open: ${harnessManagementSnapshot.location}`
  )
  const managementTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(managementTabId, 'Harness management page did not expose its workspace tab ID')
  const activeWorkspaceContentSelector = '[data-workspace-tab-content][aria-hidden="false"]'
  assert.ok(sharedSmartAppId, 'Shared Smart app fixture did not expose its catalog ID')
  const sharedVisibilitySelector =
    `${activeWorkspaceContentSelector} ` +
    `[data-testid="smart-app-visibility-${sharedSmartAppId}"]`
  await control.command('click', sharedVisibilitySelector)
  await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
    text: '管理范围',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="smart-app-share-scope-public"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
    text: '本地后续修改不会自动同步',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="smart-app-share-save"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-access-success"]', {
    text: 'v0.0.9 已上架到智能应用市场。',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-05a-public-snapshot-listed.png', 'body')
  await control.command('click', '[data-testid="smart-app-access-view-marketplace"]')
  await control.command(
    'waitFor',
    `${activeWorkspaceContentSelector} ` +
      `[data-testid="smart-app-marketplace-item-${sharedSmartAppId}"]`,
    {
      text: '我发布的',
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'click',
    `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
  )
  await control.command('waitFor', sharedVisibilitySelector, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', sharedVisibilitySelector)
  await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="smart-app-share-scope-private"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="smart-app-share-save"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-access-success"]', {
    text: '分享范围已保存。',
    timeoutMs: uiTimeoutMs,
  })
  assert.ok(ownerRequest, 'Smart app owner API was not prepared')
  const privateCatalog = await ownerRequest('/api/smart-apps/marketplace?source=public')
  assert.equal(
    privateCatalog.items.some(item => item.id === sharedSmartAppId),
    false,
    'Making the Smart app private left it listed in the public marketplace'
  )
  await waitForMissing(control, '[data-testid="smart-app-share-dialog"]', uiTimeoutMs)
  await control.command('click', sharedVisibilitySelector)
  await control.command('waitFor', '[data-testid="smart-app-share-scope-private"]', {
    timeoutMs: uiTimeoutMs,
  })
  assert.match(
    await control.command('getAttribute', '[data-testid="smart-app-share-scope-private"]', {
      value: 'class',
    }),
    /\bbg-background\b.*\bshadow-sm\b/,
    'Reopening Smart app access settings did not restore the private scope'
  )
  await control.command('click', '[data-testid="smart-app-share-cancel"]')
  await captureScreenshot(control, 'harness-apps-05-installed.png', 'body')
  await control.command('click', `[data-testid="smart-app-actions-${INSTALLATION_ID}"]`)
  await control.command('waitFor', `[data-testid="smart-app-export-package-${INSTALLATION_ID}"]`, {
    text: '导出发布包',
    timeoutMs: uiTimeoutMs,
  })
  const installedExportsBefore = await exportedPackages(downloadsPath)
  await control.command('click', `[data-testid="smart-app-export-package-${INSTALLATION_ID}"]`)
  await control.command('waitFor', '[data-testid="smart-app-export-success"]', {
    text: '发布包已导出到下载目录。',
    timeoutMs: uiTimeoutMs,
  })
  await assertExportedPackage({
    archivePath: await waitForNewExport(downloadsPath, installedExportsBefore, uiTimeoutMs),
    expectedName: INSTALLATION_ID,
    expectedVersion: '0.1.0',
    extractionPath: join(resultDir, 'installed-export-verification'),
  })
  await captureScreenshot(control, 'harness-apps-05a-exported.png', 'body')

  const importedModelSelector = `[data-testid="harness-app-model-${IMPORTED_INSTALLATION_ID}"]`
  await control.command('select', importedModelSelector, {
    by: 'label',
    value: MODEL_LABEL,
  })
  await control.command('waitFor', importedModelSelector, {
    enabled: true,
    stableMs: 300,
    timeoutMs: 30_000,
  })
  await control.command(
    'clickWhenEnabled',
    `[data-testid="harness-app-start-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: 30_000,
    }
  )
  await control.command(
    'waitFor',
    `[data-testid="harness-app-launch-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: 30_000,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'waitFor',
    `[data-testid="app-iframe-harness-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: 600_000,
    }
  )
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command(
    'waitFor',
    `${activeWorkspaceContentSelector} [data-testid="harness-app-open-${IMPORTED_INSTALLATION_ID}"]`,
    { timeoutMs: 30_000 }
  )
  await control.command(
    'click',
    `${activeWorkspaceContentSelector} [data-testid="smart-app-actions-${IMPORTED_INSTALLATION_ID}"]`
  )
  await control.command(
    'waitFor',
    `[data-testid="smart-app-stop-menu-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="smart-app-stop-menu-${IMPORTED_INSTALLATION_ID}"]`)
  await control.command(
    'waitFor',
    `[data-testid="harness-app-start-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: 30_000,
    }
  )

  // Stopped state can render before route cleanup and the list refresh complete.
  await control.command('waitFor', importedModelSelector, {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('scrollIntoView', importedModelSelector)
  await control.command('waitFor', importedModelSelector, {
    visible: true,
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  const modelSelector = `[data-testid="harness-app-model-${INSTALLATION_ID}"]`
  const initialModelKey = await control.command('getValue', modelSelector)
  await control.command('select', modelSelector, {
    by: 'label',
    value: MODEL_LABEL,
  })
  await control.command('waitFor', modelSelector, {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  const selectedModelKey = await control.command('getValue', modelSelector)
  assert.notEqual(
    selectedModelKey,
    initialModelKey,
    'Changing the installed Smart app model did not persist a new selection'
  )
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`,
    {
      stableMs: 300,
      timeoutMs: uiTimeoutMs,
    }
  )
  await captureScreenshot(control, 'harness-apps-06-direct-add-menu.png', 'body')
  await control.command('press', 'body', { key: 'Escape' })

  await control.command('click', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`)
  await control.command('waitFor', `[data-testid="harness-app-launch-${INSTALLATION_ID}"]`, {
    timeoutMs: 30_000,
  })
  await captureScreenshot(control, 'harness-apps-07-tab-starting.png', 'body')
  const appSurface = `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`
  await control.command('waitFor', appSurface, {
    timeoutMs: 600_000,
  })
  const appTabId = await control.command('getAttribute', appSurface, {
    value: 'data-workspace-tab-id',
  })
  const appWebviewLabel = await control.command('getAttribute', appSurface, {
    value: 'data-embedded-browser-label',
  })
  assert.ok(appTabId, 'Harness app did not expose its workspace tab ID')
  assert.ok(appWebviewLabel, 'Harness app did not expose its native WebView label')
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${appTabId}"][aria-selected="true"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await captureScreenshot(control, 'harness-apps-08a-workbench-loaded.png', 'body')
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    visible: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-08b-workbench-add-menu.png', 'body')
  await control.command('press', 'body', { key: 'Escape' })
  await control.command('contextMenu', `[data-testid="workspace-tab-select-${appTabId}"]`)
  await control.command('waitFor', '[data-testid="workspace-tab-context-menu"]', {
    visible: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-08c-workbench-context-menu.png', 'body')
  await control.command('press', 'body', { key: 'Escape' })
  const appWorkspaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    appWorkspaceSnapshot.location.includes(APP_ROUTE),
    `Harness app workspace route did not open: ${appWorkspaceSnapshot.location}`
  )
  const harnessStateKey = '__weworkHarnessTabState'
  const harnessStateValue = `preserved-${Date.now()}`
  await control.command('setEmbeddedBrowserWindowValue', 'body', {
    value: JSON.stringify({
      key: harnessStateKey,
      label: appWebviewLabel,
      value: harnessStateValue,
    }),
    timeoutMs: uiTimeoutMs,
  })
  const nativeSnapshot = await control.command('captureEmbeddedBrowser', appSurface, {
    timeoutMs: 30_000,
  })
  assert.ok(
    nativeSnapshot.startsWith('data:image/png;base64,'),
    'Harness native WebView did not produce a screenshot'
  )
  await writeFile(
    join(resultDir, 'harness-apps-08-native-page.png'),
    Buffer.from(nativeSnapshot.slice('data:image/png;base64,'.length), 'base64')
  )
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${appTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-content-${appTabId}"][aria-hidden="false"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  assert.equal(
    await control.command('getEmbeddedBrowserWindowValue', 'body', {
      value: JSON.stringify({
        key: harnessStateKey,
        label: appWebviewLabel,
      }),
      timeoutMs: uiTimeoutMs,
    }),
    harnessStateValue,
    'Switching away from and back to a Harness app reset its in-memory page state'
  )
  const taskTabSelector = '[role="tab"][data-tab-kind="task"]'
  await control.command('click', taskTabSelector)
  await control.command(
    'waitFor',
    '[data-testid="workbench-main-header"] [data-testid="titlebar-main-actions"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'waitFor',
    '[data-testid="workbench-main-header"] [data-testid="toggle-right-workspace-panel-button"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${appTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-content-${appTabId}"][aria-hidden="false"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  const managedAppCard = `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${INSTALLATION_ID}"]`
  const managedAppOpen = `${managedAppCard} [data-testid="harness-app-open-${INSTALLATION_ID}"]`
  const managedAppStart = `${managedAppCard} [data-testid="harness-app-start-${INSTALLATION_ID}"]`
  const managedAppActions = `${managedAppCard} [data-testid="smart-app-actions-${INSTALLATION_ID}"]`
  await control.command('waitFor', managedAppOpen, {
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-09-running.png', 'body')
  await control.command('click', `[data-testid="workspace-tab-close-${appTabId}"]`)
  await waitForElementCount(
    control,
    `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`,
    0,
    uiTimeoutMs,
    'Closing a running Harness app tab left its app surface mounted'
  )
  await control.command('waitFor', managedAppStart, {
    enabled: true,
    timeoutMs: 30_000,
  })
  await control.command('clickWhenEnabled', managedAppStart, {
    timeoutMs: 30_000,
  })
  await control.command('waitFor', appSurface, {
    timeoutMs: 30_000,
  })
  await captureScreenshot(control, 'harness-apps-09a-reopened.png', 'body')
  assert.deepEqual(
    await verifyDownloadedDshRuntimeCache(join(resultDir, 'harness-runtime'), '0.1.0-rc.8'),
    legacyRuntimeCache,
    'Reopening a legacy app must reuse its previously verified runtime archive'
  )
  const reopenedAppTabId = await control.command('getAttribute', appSurface, {
    value: 'data-workspace-tab-id',
  })
  assert.ok(reopenedAppTabId, 'Reopened Harness app did not expose its workspace tab ID')
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', managedAppOpen, {
    visible: true,
    timeoutMs: 30_000,
  })
  await control.command('click', managedAppActions)
  await control.command('waitFor', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`)
  await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
    timeoutMs: 30_000,
  })
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`
      )
    ),
    0,
    'Stopping a Harness app left its stale app tab mounted'
  )
  const readyCountBeforeReload = control.readyCount
  const stoppedSnapshot = await control.command('reloadMainWindow', 'body', {
    value: 'capture',
    timeoutMs: 90_000,
  })
  assert.ok(
    stoppedSnapshot.startsWith('data:image/png;base64,'),
    'Stopped Smart app state did not produce a screenshot before reload'
  )
  await writeFile(
    join(resultDir, 'harness-apps-10-stopped.png'),
    Buffer.from(stoppedSnapshot.slice('data:image/png;base64,'.length), 'base64')
  )
  await control.awaitReadyAfter(readyCountBeforeReload)
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`,
    {
      stableMs: 300,
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`)
  await control.command('waitFor', `[data-testid="harness-app-launch-${INSTALLATION_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`, {
    timeoutMs: 600_000,
  })
  await captureScreenshot(control, 'harness-apps-11-direct-add-opened.png', 'body')
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-smart-app"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add-smart-app"]')
  await control.command(
    'click',
    `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
  )
  await control.command('waitFor', managedAppOpen, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', managedAppActions)
  await control.command('waitFor', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`)
  await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
    timeoutMs: 30_000,
  })
  await captureScreenshot(control, 'harness-apps-12-direct-add-stopped.png', 'body')

  const marketplaceSectionSelector = `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-marketplace"]`
  await control.command('click', marketplaceSectionSelector)
  await control.command('waitFor', `${marketplaceSectionSelector}[aria-current="page"]`, {
    stableMs: 1000,
    timeoutMs: uiTimeoutMs,
  })
  await control.command(
    'waitFor',
    `${activeWorkspaceContentSelector} [data-testid="smart-apps-marketplace-page"]`,
    {
      stableMs: 1000,
      timeoutMs: uiTimeoutMs,
    }
  )
  const marketplaceActionsSelector = `${activeWorkspaceContentSelector} [data-testid="smart-app-marketplace-actions-1"]`
  await control.command('waitFor', marketplaceActionsSelector, {
    timeoutMs: uiTimeoutMs,
  })
  const returnedMarketplaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    returnedMarketplaceSnapshot.location.includes('/sites?app_type=smart_app') &&
      !returnedMarketplaceSnapshot.location.includes('view=owned'),
    `My Smart apps did not return to the marketplace: ${returnedMarketplaceSnapshot.location}`
  )
  await captureScreenshot(control, 'harness-apps-15-returned-to-marketplace.png', 'body')

  await control.command('click', marketplaceActionsSelector)
  await control.command('waitFor', '[data-testid="smart-app-remove-local-market-1"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-remove-local-market-1"]')
  await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await waitForElementCount(
    control,
    '[data-testid="smart-app-marketplace-actions-1"]',
    0,
    uiTimeoutMs,
    'Removing a marketplace installation left its local actions visible'
  )
  await control.command('waitFor', '[data-testid="smart-app-marketplace-item-1-state"]', {
    text: '未安装',
    timeoutMs: uiTimeoutMs,
  })

  await control.command(
    'click',
    `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
  )
  await control.command(
    'waitFor',
    `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'click',
    `${activeWorkspaceContentSelector} [data-testid="smart-app-actions-${IMPORTED_INSTALLATION_ID}"]`
  )
  await control.command(
    'waitFor',
    `[data-testid="smart-app-remove-local-${IMPORTED_INSTALLATION_ID}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command(
    'click',
    `[data-testid="smart-app-remove-local-${IMPORTED_INSTALLATION_ID}"]`
  )
  await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await waitForElementCount(
    control,
    `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
    0,
    uiTimeoutMs,
    'Removing an imported workbench left its card visible in My'
  )
  await captureScreenshot(control, 'harness-apps-15a-local-removal-semantics.png', 'body')
  for (const eventName of [
    'smart_app_start_succeeded',
    'smart_app_stop_succeeded',
    'smart_app_export_succeeded',
    'smart_app_share_succeeded',
    'smart_app_uninstall_succeeded',
  ]) {
    const request = await control.awaitTelemetryEvent(eventName)
    const event = telemetryEvents(request.payload).find(item => item.event === eventName)
    assert.equal(event?.properties.domain, 'smart_app')
    if (eventName === 'smart_app_start_succeeded') {
      assert.match(
        event?.properties.startup_id ?? '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'Smart App startup success did not include a UUID correlation ID'
      )
      const attempted = control.telemetryRequests
        .flatMap(candidate => telemetryEvents(candidate.payload))
        .find(
          candidate =>
            candidate.event === 'smart_app_start_attempted' &&
            candidate.properties?.startup_id === event.properties.startup_id
        )
      assert.ok(attempted, 'Smart App startup success had no correlated attempt event')
    }
    for (const privateKey of [
      'smart_app_name',
      'smart_app_id',
      'file_path',
      'email',
      'error_message',
    ]) {
      assert.equal(privateKey in event.properties, false, `Private property leaked: ${privateKey}`)
    }
  }

  await verifySmartAppMarketplaceIdentity({
    control,
    ownerRequest,
    installationId: INSTALLATION_ID,
    publicationId: sharedSmartAppId,
    captureScreenshot,
    uiTimeoutMs,
  })

  await setExperimentalFeatures(control, false, uiTimeoutMs)
  await control.command('navigate', 'body', { value: '/sites' })
  await control.command('waitFor', '[data-testid="sites-workspace"]', {
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="applications-tab-smart-app"]')),
    0,
    'Smart apps remained visible in Applications after experimental features were disabled'
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="workspace-tab-add-smart-app"]')),
    0,
    'Smart apps remained visible after experimental features were disabled'
  )
  await captureScreenshot(control, 'harness-apps-16-experimental-disabled.png', 'body')
}
