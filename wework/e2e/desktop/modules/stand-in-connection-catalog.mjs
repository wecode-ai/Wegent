import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

/** Verify catalog navigation and draft persistence with the real local runtime. */
export async function verifyStandInConnectionCatalog(control, uiTimeoutMs, captureScreenshot) {
  const dingtalk = '[data-testid="stand-in-add-dingtalk-connection"]'
  const projects = '[data-testid="stand-in-add-projects-connection"]'
  const receive = '[data-testid="stand-in-source-collaboration"]'
  const panel = '[data-testid="stand-in-primary-profile"]'
  await control.command('waitFor', '[data-testid="stand-in-connected-list"]')
  await control.command('waitFor', dingtalk, { text: '迁移连接' })
  await control.command('waitFor', dingtalk, { text: '钉钉' })
  assert.equal(await control.command('getElementCount', dingtalk), '1')
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-add-connection"]'),
    '0'
  )
  await captureScreenshot(control, 'connection-01-source-catalog.png', panel)
  const search = '[data-testid="stand-in-connection-search"]'
  const configuredFilter = '[data-testid="stand-in-connection-configured-filter"]'
  await control.command('fill', search, { value: '迁移连接' })
  await control.command('waitFor', dingtalk)
  await control.command('waitFor', projects, { visible: false })
  await captureScreenshot(control, 'connection-04-search-scope.png', panel)
  await control.command('fill', search, { value: 'no-matching-source' })
  await control.command('waitFor', `${panel} [role="status"]`, { text: '没有匹配的连接' })
  await control.command('fill', search, { value: '' })
  await control.command('click', configuredFilter)
  await control.command('waitFor', '[data-testid="stand-in-available-list"]', { visible: false })
  await control.command('waitFor', dingtalk)
  await control.command('click', configuredFilter)
  await control.command('waitFor', projects)
  await control.command('waitFor', '[data-testid="stand-in-time-connections"]')
  await control.command('click', projects)
  await control.command('waitFor', receive)
  const enabled =
    (await control.command('getAttribute', receive, { value: 'aria-checked' })) === 'true'
  await control.command('click', receive)
  await control.command('waitFor', '[data-testid="stand-in-connections-pending"]')
  await control.command('click', receive)
  await control.command('waitFor', '[data-testid="stand-in-connections-pending"]', {
    visible: false,
  })
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-primary-save"]:disabled'),
    '1',
    'Restoring the original intake setting must clear the unsaved draft'
  )
  if (!enabled) {
    await control.command('waitFor', '[data-testid="stand-in-all-projects"]:checked:disabled')
  }
  await control.command('click', receive)
  await control.command('waitFor', '[data-testid="stand-in-connections-pending"]')
  await captureScreenshot(control, 'connection-02-pending-scope.png', panel)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
  await control.command('waitFor', panel, { visible: false })
  const saved = await requestExecutor(
    control,
    'runtime.stand_in.personal.get',
    { userId: 9001 },
    uiTimeoutMs
  )
  assert.equal(saved.primary.collaboration.enabled, !enabled)
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
  await control.command('waitFor', dingtalk, { text: '迁移连接' })
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-connections-pending"]'),
    '0'
  )
  await captureScreenshot(control, 'connection-03-saved-catalog.png', panel)
  await control.command('click', projects)
  await control.command('waitFor', receive)
  assert.equal(
    await control.command('getAttribute', receive, { value: 'aria-checked' }),
    String(!enabled)
  )
  await control.command('click', '[data-testid="stand-in-connections-back"]')
  await control.command('waitFor', '[data-testid="stand-in-connection-type-picker"]')
}
