import { addAllProjectScopes, clearProjectScopes } from './stand-in-flows.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { verifyProjectFieldFocus } from './project-create-focus-indicator.mjs'

/** Verify catalog navigation and draft persistence with the real local runtime. */
export async function verifyStandInConnectionCatalog(control, uiTimeoutMs, captureScreenshot) {
  const dingtalk = '[data-testid="stand-in-add-dingtalk-connection"]'
  const projects = '[data-testid="stand-in-add-projects-connection"]'
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
  await verifyProjectFieldFocus(control, 'stand-in-connection-search', {
    includeParent: true,
    nextButtonPattern: /^stand-in-add-.+-connection$/,
  })
  await control.command('fill', search, { value: '迁移连接' })
  await control.command('waitFor', dingtalk)
  await control.command('waitFor', projects, { visible: false })
  await captureScreenshot(control, 'connection-04-search-scope.png', panel)
  await control.command('fill', search, { value: 'no-matching-source' })
  await control.command('waitFor', `${panel} [role="status"]`, { text: '没有匹配的连接' })
  await control.command('fill', search, { value: '' })
  await control.command('waitFor', '[data-testid="stand-in-available-list"]')
  await control.command('waitFor', projects)
  await control.command('waitFor', '[data-testid="stand-in-time-connections"]')
  await control.command('click', projects)
  await control.command('waitFor', '[data-testid="stand-in-project-add-scope"]')
  await addAllProjectScopes(control)
  await control.command('waitFor', '[data-testid="stand-in-connections-pending"]')
  await clearProjectScopes(control)
  await control.command('waitFor', '[data-testid="stand-in-connections-pending"]', {
    visible: false,
  })
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-primary-save"]:disabled'),
    '1',
    'Restoring the original intake setting must clear the unsaved draft'
  )
  await control.command('waitFor', '[data-testid="stand-in-source-projects"]', { visible: false })
  await addAllProjectScopes(control)
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
  assert.equal(saved.primary.collaboration.enabled, true)
  assert.equal(saved.primary.collaboration.allProjects, true)
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
  await control.command('waitFor', dingtalk, { text: '迁移连接' })
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-connections-pending"]'),
    '0'
  )
  await captureScreenshot(control, 'connection-03-saved-catalog.png', panel)
  await control.command('click', projects)
  await control.command('waitFor', '[data-testid="stand-in-project-open-scope-projects"]')
  await control.command('click', '[data-testid="stand-in-connections-back"]')
  await control.command('waitFor', '[data-testid="stand-in-connection-type-picker"]')
}
