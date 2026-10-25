import { describe, expect, test } from 'vitest'
import { toWegentStoreInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import {
  mergeInstalledPlugins,
  mergeLocalInstalledWithStorePackages,
} from '@wegent/chat-core/installed-plugin-merge'
import type { WegentStorePluginSummary } from '@wegent/chat-core/codex-plugin-types'

function installation(error?: string) {
  const summary: WegentStorePluginSummary = {
    name: 'mail',
    marketplace: 'wegent',
    packageId: 'mail@wegent',
    installedPluginId: 42,
    cloudPluginId: 9,
    enabled: false,
    version: '1.0.0',
    pluginPath: error ? '' : '/isolated/workbench/shared/plugins/package',
    runtimeRecoveryError: error,
  }
  return toWegentStoreInstalledPlugin(summary, '/isolated/workbench/shared/plugins', key => key)
}

describe('plugin runtime recovery projection', () => {
  test('preserves disabled installation identity when the package is unavailable', () => {
    const plugin = installation('Verified package is missing')
    expect(plugin.spec.enabled).toBe(false)
    expect(plugin.spec.sourcePayload).toMatchObject({
      cloudInstalledPluginId: 42,
      cloudPluginId: 9,
      runtimeRecoveryError: 'Verified package is missing',
    })
    expect(plugin.status.state).toBe('recovery_required')
  })

  test('keeps local repair state through native and cloud membership merges', () => {
    const native = installation()
    const failed = installation('Target is occupied')
    const local = mergeLocalInstalledWithStorePackages([native], [failed])
    expect(local).toHaveLength(1)
    expect(local[0].spec.sourcePayload?.runtimeRecoveryError).toBe('Target is occupied')

    const cloud = {
      ...native,
      spec: { ...native.spec, pluginId: 9, releaseId: 11, sourcePayload: null },
    }
    const merged = mergeInstalledPlugins([cloud], local)
    expect(merged).toHaveLength(1)
    expect(merged[0].spec.sourcePayload?.runtimeRecoveryError).toBe('Target is occupied')
    expect(merged[0].spec.enabled).toBe(false)
  })

  test('clears a previous error after a successful local recovery', () => {
    const available = installation()
    delete available.spec.sourcePayload?.runtimeRecoveryError
    const repaired = mergeLocalInstalledWithStorePackages(
      [installation('Verified package is missing')],
      [available]
    )
    expect(repaired).toHaveLength(1)
    expect(repaired[0].spec.sourcePayload?.runtimeRecoveryError).toBeNull()
    expect(repaired[0].status.state).toBe(installation().status.state)
  })
})
