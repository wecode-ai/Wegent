import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { subscribeBusinessEvents } from '@/telemetry/businessEvents'
import { subscribeOperationResults } from '@/telemetry/operationBus'
import {
  recordPluginInstallationAccepted,
  reconcilePluginInstallation,
} from './pluginInstallTelemetry'

function plugin(id: string, state: 'pending' | 'installed' | 'failed'): InstalledPlugin {
  return {
    metadata: { labels: { id } },
    spec: { releaseId: 7, installState: 'installed' },
    status: {
      devices: [
        {
          deviceId: 'device',
          state,
          desiredReleaseId: 7,
          actualReleaseId: state === 'installed' ? 7 : null,
        },
      ],
    },
  } as InstalledPlugin
}

describe('plugin installation telemetry', () => {
  test('waits for the matching device release and reports a final result only once', () => {
    const events: unknown[] = []
    const results: unknown[] = []
    const stopEvents = subscribeBusinessEvents(event => events.push(event))
    const stopResults = subscribeOperationResults(result => results.push(result))
    try {
      const installed = plugin('pending-install', 'pending')
      recordPluginInstallationAccepted(installed, 'device', 'cloud')
      expect(events).toEqual([])
      expect(results).toEqual([])
      const wrongRelease = plugin('pending-install', 'installed')
      wrongRelease.status.devices![0].actualReleaseId = 6
      reconcilePluginInstallation(wrongRelease, 'device')
      expect(events).toEqual([])
      reconcilePluginInstallation(plugin('pending-install', 'installed'), 'other-device')
      expect(events).toEqual([])
      reconcilePluginInstallation(plugin('pending-install', 'installed'), 'device')
      reconcilePluginInstallation(plugin('pending-install', 'installed'), 'device')
      expect(events).toEqual([{ name: 'plugin_installed', properties: { source: 'cloud' } }])
      expect(results).toHaveLength(1)
    } finally {
      stopEvents()
      stopResults()
    }
  })

  test('does not count a failed device sync as installed and allows an explicit retry', () => {
    const events: unknown[] = []
    const results: unknown[] = []
    const stopEvents = subscribeBusinessEvents(event => events.push(event))
    const stopResults = subscribeOperationResults(result => results.push(result))
    try {
      recordPluginInstallationAccepted(plugin('failed-install', 'failed'), 'device', 'cloud')
      expect(events).toEqual([])
      expect(results).toContainEqual({
        key: 'plugin.device_install',
        outcome: 'failed',
        failureStage: 'confirm',
      })
      recordPluginInstallationAccepted(plugin('failed-install', 'installed'), 'device', 'cloud')
      expect(events).toHaveLength(1)
    } finally {
      stopEvents()
      stopResults()
    }
  })
})
