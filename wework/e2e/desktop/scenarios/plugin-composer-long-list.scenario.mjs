import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_COMPOSER_SELECTOR } from '../modules/shared.mjs'
import { verifyPluginTogglePersistence } from '../modules/plugin-inventory-state.mjs'
import {
  inventory,
  openPlugin,
  pluginApi,
  testId,
  until,
} from '../modules/plugin-regression-fixture.mjs'

export async function createDesktopScenario({
  captureScreenshot,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  let cloud
  let restartDesktopApp
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },
    async verify(control) {
      const local = await cloud.waitForConnectedAppDevice()
      const fixtures = []
      // Each standalone checkpoint creates its own real packages/account installs.
      for (let index = 1; index <= 24; index += 1) {
        const slug = `composer-list-e2e-${String(index).padStart(2, '0')}`
        const release = await cloud.publishPluginRelease({
          slug,
          version: '1.0.0',
          skills: { [slug]: `Use ${slug}` },
        })
        await pluginApi(
          cloud,
          `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(local.device_id)}`,
          'POST'
        )
        fixtures.push({ ...release, slug })
      }
      await openPlugin(control, fixtures[0])
      await control.command('click', testId('plugins-refresh-button'))
      await until(
        () => inventory(control),
        state =>
          fixtures.every(
            fixture =>
              state.sharedInventory.installedPlugins.some(
                item => item.pluginKey === fixture.slug
              ) && state.composerApps.some(item => item.pluginKey === fixture.slug)
          ),
        'Not all 24 real plugins reached the shared inventory and composer',
        workbenchReadyTimeoutMs
      )
      await control.command('click', testId('new-chat-button'))
      await control.command('click', testId('composer-plugin-picker-button'))
      const picker = testId('composer-plugin-picker')
      await control.command('waitFor', picker)
      const snapshot = JSON.parse(await control.command('snapshot', picker))
      const itemIds = snapshot.testIds.filter(id => id.startsWith('composer-plugin-picker-item-'))
      for (const fixture of fixtures) {
        assert.ok(
          itemIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`),
          `Picker truncated ${fixture.slug}`
        )
      }
      assert.ok(itemIds.length >= 24)
      const scroller = `${picker} > div:has(> button[data-testid^="composer-plugin-picker-item-"])`
      const metrics = async selector =>
        JSON.parse(await control.command('getElementMetrics', selector))[0]
      const before = await metrics(scroller)
      assert.ok(
        before.clientHeight > 0 && before.clientHeight <= 280,
        'Picker lost its bounded display height'
      )
      assert.ok(before.scrollHeight > before.clientHeight, 'Fixture does not exercise overflow')
      assert.equal(before.scrollTop, 0)
      // Snapshot test IDs are sorted, not DOM ordered. Find the actual last row.
      const positions = []
      for (const id of itemIds) positions.push({ id, metrics: await metrics(testId(id)) })
      positions.sort((left, right) => left.metrics.top - right.metrics.top)
      const { id: lastId, metrics: lastBefore } = positions.at(-1)
      assert.ok(lastBefore.top >= before.bottom, 'Last plugin was already in the initial viewport')
      await control.command('scrollToBottomAsUser', scroller)
      const after = await until(
        () => metrics(scroller),
        value => value.scrollTop > 0,
        'Picker cannot scroll'
      )
      const lastAfter = await metrics(testId(lastId))
      assert.ok(
        lastAfter.top >= after.top - 1 && lastAfter.bottom <= after.bottom + 1,
        'Last plugin is clipped after scrolling to the bottom'
      )
      assert.equal(
        after.clientHeight,
        before.clientHeight,
        'Scrolling changed the picker display height'
      )
      await captureScreenshot(control, 'plugin-composer-long-list-bottom.png', picker)
      const appId = lastId.slice('composer-plugin-picker-item-'.length)
      const app = (await inventory(control)).composerApps.find(item => item.id === appId)
      assert.ok(app, 'Last picker row has no shared inventory entry')
      await control.command('click', testId(lastId))
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { text: app.name })
      assert.ok(
        !JSON.parse(await control.command('snapshot', 'body')).testIds.includes(
          'composer-plugin-picker'
        ),
        'Selecting the last plugin did not close the picker'
      )
      await writeFile(
        join(resultDir, 'plugin-composer-long-list.json'),
        JSON.stringify(
          { count: itemIds.length, lastId, before, after, lastBefore, lastAfter },
          null,
          2
        )
      )
      await verifyPluginTogglePersistence({
        control,
        cloud,
        fixture: fixtures[0],
        restartDesktopApp,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-enabled-after-restart.png', 'body')
    },
  }
}
