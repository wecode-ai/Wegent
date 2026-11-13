import {
  openStandInSettings,
  verifyStandInProfileNavigation,
} from '../modules/stand-in-profile-navigation.mjs'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { verifyStandInProjectConnectionNames } from '../modules/stand-in-project-connections.mjs'
import { verifyStandInConnectionCatalog } from '../modules/stand-in-connection-catalog.mjs'
import { verifyStandInSessionSettings } from '../modules/stand-in-session-settings.mjs'
import { verifyStandInGroupMessageScope } from '../modules/stand-in-group-message-scope.mjs'

const DINGTALK = '@wegent/dsh-connection-dingtalk/dingtalk'
const USER = 9001

export function createDesktopScenario(options) {
  const { uiTimeoutMs, workbenchReadyTimeoutMs } = options
  const fixture = createStandInDingTalkFixture(options)
  return {
    prepareApp: fixture.prepareApp,
    async verify(control) {
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      try {
        // Startup model reconciliation can start and restart the shared Codex server.
        await control.command('ensureLocalModelCatalogReady', 'body', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        const catalog = await requestExecutor(
          control,
          'runtime.connections.catalog',
          {},
          uiTimeoutMs
        )
        const provider = catalog.items.find(item => item.id === DINGTALK)
        assert.ok(provider, 'The real Wework plugin registry must expose the DingTalk provider')
        assert.deepEqual(provider.resourceKinds, ['group', 'direct'])
        assert.equal(provider.dependencies[0].source.pluginId, 'dingtalk@wework')
        await fixture.install(control)
        // Startup sync also restarts Codex. Both local markets and the installed
        // dependency must survive that boundary, rather than exist only in memory.
        const restarted = await requestExecutor(
          control,
          'runtime.codex.app_server.restart',
          {},
          uiTimeoutMs
        )
        assert.equal(restarted.restarted, true, 'The persistence check must restart real Codex')
        const persistedMarkets = await requestExecutor(
          control,
          'runtime.codex.app_server.request',
          { method: 'plugin/list', params: { cwds: null, marketplaceKinds: ['local'] } },
          uiTimeoutMs
        )
        for (const name of ['wework', 'wework-personal']) {
          assert.ok(
            persistedMarkets.marketplaces.some(market => market.name === name),
            `Codex restart lost the registered ${name} marketplace`
          )
        }
        const persistedCatalog = await requestExecutor(
          control,
          'runtime.connections.catalog',
          {},
          uiTimeoutMs
        )
        assert.equal(
          persistedCatalog.items.find(item => item.id === DINGTALK)?.availability.status,
          'ready',
          'Codex restart lost the installed DingTalk dependency'
        )
        const source = {
          id: 'connection-migration-fixture',
          profile: 'connection-test-account',
          name: '迁移连接',
          kind: 'group',
          policy: { automatic: false, askBeforeAct: true },
        }
        const primary = {
          ...initial.primary,
          enabled: false,
          prompt: '',
          preferences: '',
          dingtalk: [source],
        }
        delete primary.connections
        const saved = await requestExecutor(
          control,
          'runtime.stand_in.personal.save',
          {
            userId: USER,
            settings: { ...initial, primary },
          },
          uiTimeoutMs
        )
        assert.equal(saved.primary.dingtalk, undefined)
        assert.equal(saved.primary.connections[0].providerId, DINGTALK)
        assert.deepEqual(saved.primary.connections[0].policy, { ...source.policy, immediate: true })
        const loaded = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId: USER },
          uiTimeoutMs
        )
        assert.deepEqual(loaded.primary.connections, saved.primary.connections)
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', '[data-testid="stand-in-overview"]')
        await verifyStandInProfileNavigation(control, options.captureScreenshot)
        await openStandInSettings(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-connections-open"]'
        )
        await control.command('waitFor', '[data-testid="stand-in-connection-settings"]')
        await verifyStandInConnectionCatalog(control, uiTimeoutMs, options.captureScreenshot)
        await openConnectionTypePicker(control)
        await control.command('waitFor', '[data-testid="stand-in-add-dingtalk-connection"]')
        await control.command('click', '[data-testid="stand-in-add-dingtalk-connection"]')
        await control.command('waitFor', '[data-testid="stand-in-dingtalk-connections"]')
        await verifyStandInSessionSettings(control, uiTimeoutMs)
        await verifyStandInGroupMessageScope(control, uiTimeoutMs)
        await control.command('click', '[data-testid="stand-in-primary-cancel"]')
        await verifyStandInProjectConnectionNames(control, uiTimeoutMs)
      } finally {
        const current = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId: USER },
          uiTimeoutMs
        )
        await requestExecutor(
          control,
          'runtime.stand_in.personal.save',
          { userId: USER, settings: { ...initial, version: current.version } },
          uiTimeoutMs
        )
      }
    },
  }
}
