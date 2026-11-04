// @vitest-environment node

import { expect, test } from 'vitest'
import { assertPluginDetailMembership } from '../e2e/desktop/modules/plugin-detail-cache-race.mjs'

function inventory() {
  return {
    installedPlugins: [{ pluginKey: 'demo', enabled: false, installState: 'installed' }],
    installedSourceReads: { codex: { status: 'fulfilled' } },
    sharedInventory: {
      deviceId: 'device',
      installedPlugins: [{ pluginKey: 'demo', enabled: false, installState: 'installed' }],
    },
  }
}

test.each([false, true])(
  'keeps disabled membership when the adapter cache is invalidated=%s',
  invalidated => {
    const before = inventory()
    const after = inventory()
    if (invalidated) {
      after.installedPlugins = []
      after.installedSourceReads = {}
    }
    expect(() => assertPluginDetailMembership(before, after, 'demo')).not.toThrow()
  }
)

test.each(['adapter-enabled', 'adapter-missing', 'shared-enabled', 'shared-missing', 'device'])(
  'rejects an actual membership regression: %s',
  fault => {
    const before = inventory()
    const after = inventory()
    if (fault === 'adapter-enabled') after.installedPlugins[0].enabled = true
    if (fault === 'adapter-missing') after.installedPlugins = []
    if (fault === 'shared-enabled') after.sharedInventory.installedPlugins[0].enabled = true
    if (fault === 'shared-missing') after.sharedInventory.installedPlugins = []
    if (fault === 'device') after.sharedInventory.deviceId = 'other-device'
    const message = fault.startsWith('adapter')
      ? /adapter membership/
      : fault === 'device'
        ? /device scope/
        : /shared membership/
    expect(() => assertPluginDetailMembership(before, after, 'demo')).toThrow(message)
  }
)
