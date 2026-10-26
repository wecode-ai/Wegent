import {
  LEGACY_INSTALLATION_ID,
  MODEL_LABEL,
  setExperimentalFeatures,
  waitForElementCount,
} from './harness-app-fixture.mjs'
import assert from 'node:assert/strict'
import { telemetryEvents } from './response-protocol.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyDownloadedDshRuntimeCache } from './dsh-runtime-cache.mjs'

export async function prepareHarnessAppUi(
  control,
  { uiTimeoutMs, captureScreenshot, electronUserDataDirectory, resultDir, legacyPackagePath }
) {
  await setExperimentalFeatures(control, false, uiTimeoutMs)
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="workspace-tab-add-smart-app"]')),
    0,
    'Smart apps were visible before experimental features were enabled'
  )
  await captureScreenshot(control, 'harness-apps-00-experimental-hidden.png', 'body')
  await control.command('click', '[data-testid="workspace-tab-add"]')

  await setExperimentalFeatures(control, true, uiTimeoutMs)
  await captureScreenshot(control, 'harness-apps-01-experimental-enabled.png', 'body')

  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-smart-app"]', {
    text: '智能工作台',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-02-top-tab-entry.png', 'body')
  await control.command('click', '[data-testid="workspace-tab-add-smart-app"]')
  await control.command(
    'waitFor',
    '[data-testid="applications-tab-smart-app"][aria-selected="true"]',
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  const marketplaceRequest = await control.awaitTelemetryEvent('smart_app_marketplace_opened')
  const marketplaceEvent = telemetryEvents(marketplaceRequest.payload).find(
    event => event.event === 'smart_app_marketplace_opened'
  )
  assert.equal(marketplaceEvent?.properties.domain, 'smart_app')
  await control.command('waitFor', '[data-testid="sidebar-worklists-scroll"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-apps-section-nav"]', {
    text: '市场',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-03-marketplace.png', 'body')
  const marketplaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    marketplaceSnapshot.location.includes('/sites?app_type=smart_app'),
    `Smart app marketplace did not open from the top tab add menu: ${marketplaceSnapshot.location}`
  )
  const marketplaceText = await control.command(
    'getText',
    '[data-testid="smart-apps-marketplace-page"]'
  )
  assert.ok(
    !marketplaceText.includes('创建智能应用') && !marketplaceText.includes('导入应用'),
    'Smart app marketplace unexpectedly exposed creation actions'
  )
  await control.command('waitFor', '[data-testid="smart-app-marketplace-item-1"]', {
    text: 'DSH E2E Smoke',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-marketplace-item-1"] > button')
  await control.command('waitFor', '[data-testid="smart-app-details"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-details-content"]', {
    text: '主要能力',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-details-footer"]', {
    text: '下载并安装',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-03-details.png', 'body')
  await control.command('press', 'body', { key: 'Escape' })
  await waitForElementCount(
    control,
    '[data-testid="smart-app-details"]',
    0,
    uiTimeoutMs,
    'Smart app details dialog did not close after Escape'
  )
  await control.command('click', '[data-testid="smart-app-marketplace-install-1"]')
  await control.command('waitFor', '[data-testid="harness-app-preview"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="harness-app-install-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  const installRequest = await control.awaitTelemetryEvent('smart_app_install_succeeded')
  const installEvent = telemetryEvents(installRequest.payload).find(
    event => event.event === 'smart_app_install_succeeded'
  )
  assert.ok(installEvent, 'Smart App install telemetry event was missing')
  assert.equal(installEvent?.properties.domain, 'smart_app')
  assert.equal('smart_app_name' in installEvent.properties, false)
  await control.command('waitFor', '[data-testid="harness-app-start-market-1"]', {
    timeoutMs: uiTimeoutMs,
  })
  const officialManagementTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(
    officialManagementTabId,
    'Official Harness management page did not expose its workspace tab ID'
  )
  await control.command('click', '[data-testid="harness-app-start-market-1"]')
  await control.command('waitFor', '[data-testid="harness-app-launch-market-1"]', {
    timeoutMs: 60_000,
  })
  await control.command('waitFor', '[data-testid="app-iframe-harness-market-1"]', {
    timeoutMs: 600_000,
  })
  const installations = JSON.parse(
    await readFile(join(electronUserDataDirectory, 'harness-apps', 'installations.json'), 'utf8')
  )
  assert.equal(
    installations.find(item => item.id === 'market-1')?.runtimeVersion,
    '0.2.0-rc.2',
    'A Smart app with desktop capabilities must use the authenticated runtime'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${officialManagementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${officialManagementTabId}"][aria-selected="true"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await captureScreenshot(control, 'harness-apps-03a-official-running.png', 'body')
  await control.command('waitFor', '[data-testid="smart-app-marketplace-actions-1"]', {
    timeoutMs: 60_000,
  })
  await control.command('click', '[data-testid="smart-app-marketplace-actions-1"]')
  await control.command('waitFor', `[data-testid="smart-app-stop-menu-market-1"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-stop-menu-market-1"]`)
  await control.command('waitFor', '[data-testid="harness-app-start-market-1"]', {
    timeoutMs: 30_000,
  })
  await control.command('click', '[data-testid="smart-apps-section-marketplace"]')
  await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-apps-section-owned"]')
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })

  await verifyLegacyAppRejection(control, {
    legacyPackagePath,
    electronUserDataDirectory,
    uiTimeoutMs,
  })
  const legacyRuntimeCache = await verifyDownloadedDshRuntimeCache(
    join(resultDir, 'harness-runtime'),
    '0.1.0-rc.8'
  )

  return { legacyRuntimeCache }
}

async function verifyLegacyAppRejection(
  control,
  { legacyPackagePath, electronUserDataDirectory, uiTimeoutMs }
) {
  const id = LEGACY_INSTALLATION_ID
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(legacyPackagePath).href,
        name: `${id}.zip`,
        mimeType: 'application/zip',
      },
    ]),
  })
  await control.command('waitFor', `[data-testid="smart-app-created-item-${id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
  const modelSelector = `[data-testid="harness-app-model-${id}"]`
  await control.command('waitFor', modelSelector, {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('select', modelSelector, { by: 'label', value: MODEL_LABEL })
  const managementTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(managementTabId, 'The legacy fixture management tab was not available')
  await control.command('clickWhenEnabled', `[data-testid="harness-app-start-${id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', `[data-testid="harness-app-launch-retry-${id}"]`, {
    visible: true,
    timeoutMs: 600_000,
  })
  assert.equal(
    Number(await control.command('getElementCount', `[data-testid="app-iframe-harness-${id}"]`)),
    0,
    'A legacy runtime must not expose the privileged Electron host bridge'
  )
  const installations = JSON.parse(
    await readFile(join(electronUserDataDirectory, 'harness-apps', 'installations.json'), 'utf8')
  )
  const legacy = installations.find(item => item.id === id)
  assert.equal(legacy?.state, 'failed')
  assert.equal(legacy.error, 'The trusted Electron host bridge requires DSH 0.2.0-rc.2')
  assert.equal(legacy.runtimeVersion, null)
  assert.equal(legacy.webUrl, null)
  await removeLegacyAppFixture(control, id, managementTabId, uiTimeoutMs)
}

async function removeLegacyAppFixture(control, id, managementTabId, uiTimeoutMs) {
  const failedTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(failedTabId, 'The rejected Smart app did not expose its workspace tab ID')
  await control.command('click', `[data-testid="workspace-tab-close-${failedTabId}"]`)
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command('waitFor', `[data-testid="smart-app-actions-${id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-actions-${id}"]`)
  await control.command('waitFor', `[data-testid="smart-app-remove-local-${id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-remove-local-${id}"]`)
  await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await waitForElementCount(
    control,
    `[data-testid="smart-app-created-item-${id}"]`,
    0,
    uiTimeoutMs,
    'The rejected legacy Smart app fixture was not removed'
  )
}
