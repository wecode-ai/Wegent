import assert from 'node:assert/strict'

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
  await control.command('waitFor', `[data-testid="harness-app-start-market-${marketItem.id}"]`, {
    timeoutMs: uiTimeoutMs,
  })
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
}
