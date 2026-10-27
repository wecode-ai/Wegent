import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { verifyStandInProjectConnectionNames } from '../modules/stand-in-project-connections.mjs'

const DINGTALK = '@wegent/dsh-connection-dingtalk/dingtalk'
const USER = 9001

export function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      try {
        const catalog = await requestExecutor(
          control,
          'runtime.connections.catalog',
          {},
          uiTimeoutMs
        )
        const provider = catalog.items.find(item => item.id === DINGTALK)
        assert.ok(provider, 'The real Wework plugin registry must expose the DingTalk provider')
        assert.deepEqual(provider.resourceKinds, ['group', 'direct'])
        assert.equal(provider.dependencies[0].source.pluginId, 'dingtalk@wegent')
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
        assert.deepEqual(saved.primary.connections[0].policy, source.policy)
        const loaded = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId: USER },
          uiTimeoutMs
        )
        assert.deepEqual(loaded.primary.connections, saved.primary.connections)
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="collaboration-primary-stand-in"]')
        await control.command('waitFor', '[data-testid="stand-in-overview"]')
        await control.command('click', '[data-testid="stand-in-settings-open"]')
        await control.command('waitFor', '[data-testid="stand-in-connection-settings"]')
        await control.command('click', '[data-testid="stand-in-add-connection"]')
        await control.command('waitFor', '[data-testid="stand-in-add-dingtalk-connection"]')
        await control.command('click', '[data-testid="stand-in-add-dingtalk-connection"]')
        await control.command('waitFor', '[data-testid="stand-in-dingtalk-connections"]')
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
