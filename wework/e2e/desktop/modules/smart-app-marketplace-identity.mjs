import assert from 'node:assert/strict'
import {
  MODEL_LABEL,
  confirmHarnessInstallation,
  invokeHarnessHost,
} from './harness-app-fixture.mjs'

export async function verifySmartAppMarketplaceIdentity({
  control,
  ownerRequest,
  installationId,
  publicationId,
  captureScreenshot,
  uiTimeoutMs,
}) {
  const active = '[data-workspace-tab-content][aria-hidden="false"]'
  const owned = `${active} [data-testid="smart-apps-owned-page"]`
  const managementTabId = await control.command('getAttribute', active, {
    value: 'data-workspace-tab-content',
  })
  assert.ok(managementTabId, 'Smart app marketplace did not expose its workspace tab ID')
  const catalog = await ownerRequest('/api/smart-apps/marketplace')
  const marketItem = catalog.items.find(
    item => item.name === installationId && item.sourceType === 'official'
  )
  assert.ok(marketItem, 'Same-name official market fixture is missing')
  assert.notEqual(marketItem.id, publicationId)

  await control.command('click', `${active} [data-testid="smart-app-actions-${installationId}"]`)
  await control.command('click', `[data-testid="smart-app-remove-local-${installationId}"]`)
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await control.command('waitFor', owned, {
    text: '还没有符合条件的工作台',
    timeoutMs: uiTimeoutMs,
  })
  const publications = await ownerRequest('/api/smart-apps/owned')
  assert.ok(
    publications.items.some(item => item.id === publicationId && item.name === installationId),
    'Local removal must preserve the same-name cloud publication for this regression'
  )

  await control.command('click', `${active} [data-testid="smart-apps-section-marketplace"]`)
  await control.command(
    'waitFor',
    `[data-testid="smart-app-marketplace-install-${marketItem.id}"]`,
    {
      timeoutMs: uiTimeoutMs,
    }
  )
  await control.command('click', `[data-testid="smart-app-marketplace-install-${marketItem.id}"]`)
  await control.command('waitFor', '[data-testid="harness-app-preview"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="harness-app-install-confirm"]', {
    timeoutMs: uiTimeoutMs,
  })
  await confirmHarnessInstallation(control, uiTimeoutMs)
  await control.command('waitFor', `[data-testid="harness-app-start-market-${marketItem.id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await invokeHarnessHost(control, 'smartApps.configure', {
    installationId: `market-${marketItem.id}`,
    presentation: 'tab',
    background: false,
  })
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', owned, { timeoutMs: uiTimeoutMs })
  const marketModelSelector = `${owned} [data-testid="harness-app-model-market-${marketItem.id}"]`
  await control.command('waitFor', marketModelSelector, {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('select', marketModelSelector, {
    by: 'label',
    value: MODEL_LABEL,
  })
  await control.command('waitFor', marketModelSelector, {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  const tabsBeforeDeepLink = JSON.parse(await control.command('snapshot', 'body')).testIds.filter(
    id => id.startsWith('workspace-tab-select-')
  )
  await control.command('openWeworkScheme', 'body', {
    value: `wework://smart-apps/${marketItem.id}`,
  })
  const appSurface = `${active} [data-testid^="app-iframe-harness-"]`
  await control.command('waitFor', appSurface, { timeoutMs: 600_000 })
  const appTabId = await control.command('getAttribute', appSurface, {
    value: 'data-workspace-tab-id',
  })
  assert.ok(appTabId, 'Smart app deep link did not open an app workspace tab')
  const openedSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    openedSnapshot.location.includes('/app/harness-'),
    `Smart app deep link did not open its harness route: ${openedSnapshot.location}`
  )
  assert.ok(
    !tabsBeforeDeepLink.includes(`workspace-tab-select-${appTabId}`),
    'The first Smart app deep link did not create a new app workspace tab'
  )
  assert.equal(
    openedSnapshot.testIds.filter(id => id === `workspace-tab-select-${appTabId}`).length,
    1,
    'The first Smart app deep link exposed duplicate app workspace tabs'
  )
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${appTabId}"][aria-selected="true"]`,
    { timeoutMs: uiTimeoutMs }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
    { timeoutMs: uiTimeoutMs }
  )
  await control.command('openWeworkScheme', 'body', {
    value: `wework://smart-apps/${marketItem.id}`,
  })
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${appTabId}"][aria-selected="true"]`,
    { stableMs: 300, timeoutMs: uiTimeoutMs }
  )
  const reusedSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    reusedSnapshot.location,
    openedSnapshot.location,
    'Repeated Smart app deep link navigation changed the opened app route'
  )
  assert.equal(
    reusedSnapshot.testIds.filter(id => id.startsWith('workspace-tab-select-')).length,
    openedSnapshot.testIds.filter(id => id.startsWith('workspace-tab-select-')).length,
    'Repeated Smart app deep link navigation opened another workspace tab'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
    { timeoutMs: uiTimeoutMs }
  )
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
    { timeoutMs: uiTimeoutMs }
  )
  await control.command('click', `${active} [data-testid="smart-apps-section-owned"]`)
  const card = `${active} [data-testid="smart-app-owned-item-${marketItem.id}"]`
  await control.command('waitFor', card, { text: marketItem.summary, timeoutMs: uiTimeoutMs })
  const text = await control.command('getText', card)
  assert.ok(text.includes('市场安装'), 'Reinstallation was classified as a locally created app')
  assert.ok(!text.includes('管理范围'), 'Market installation inherited historical owner actions')
  const iconUrl = await control.command('getAttribute', `${card} img`, { value: 'src' })
  assert.equal(
    new URL(iconUrl).pathname,
    new URL(marketItem.iconUrl).pathname,
    'Market installation inherited the historical publication icon'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${card} [data-testid="smart-app-visibility-${publicationId}"]`
      )
    ),
    0,
    'Market installation was associated with the historical cloud publication'
  )
  await control.command('click', `${active} [data-testid="smart-apps-owned-filter-installed"]`)
  await control.command('waitFor', card, { text: marketItem.summary, timeoutMs: uiTimeoutMs })
  await captureScreenshot(control, 'harness-apps-15b-marketplace-identity.png', 'body')

  await control.command(
    'click',
    `${active} [data-testid="smart-app-actions-market-${marketItem.id}"]`
  )
  await control.command('click', `[data-testid="smart-app-remove-local-market-${marketItem.id}"]`)
  await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
  await control.command('waitFor', owned, {
    text: '还没有符合条件的工作台',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('openWeworkScheme', 'body', {
    value: `wework://smart-apps/${marketItem.id}`,
  })
  await control.command('waitFor', '[data-testid="smart-app-deep-link-install-prompt"]', {
    text: '此智能工作台尚未安装',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-details"]', {
    text: marketItem.displayName,
    timeoutMs: uiTimeoutMs,
  })
  const installPromptSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    installPromptSnapshot.location.includes(`smartAppId=${marketItem.id}`),
    `Missing Smart app deep link did not target its marketplace identity: ${installPromptSnapshot.location}`
  )
  await captureScreenshot(control, 'harness-apps-15c-deep-link-install.png', 'body')

  await control.command('openWeworkScheme', 'body', {
    value: 'wework://smart-apps/2147483647',
  })
  await control.command('waitFor', '[data-testid="smart-app-deep-link-error"]', {
    text: '未找到此智能工作台',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-deep-link-retry"]', {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-app-deep-link-retry"]')
  await control.command('waitFor', '[data-testid="smart-app-deep-link-error"]', {
    text: '未找到此智能工作台',
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, 'harness-apps-15d-deep-link-retry.png', 'body')
}
