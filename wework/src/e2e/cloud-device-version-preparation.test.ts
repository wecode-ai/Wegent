// @vitest-environment node

import { expect, test, vi } from 'vitest'
import {
  LocalNevisSandboxService,
  RealCloudEnvironment,
} from '../../e2e/desktop/modules/cloud-environment.mjs'
import { LocalPluginObjectStorage } from '../../e2e/desktop/modules/local-plugin-object-storage.mjs'

function prepareBackend(initialExecutorLatestVersion?: string) {
  vi.spyOn(LocalPluginObjectStorage.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(LocalNevisSandboxService.prototype, 'start').mockResolvedValue(undefined)
  const environment = new RealCloudEnvironment({ initialExecutorLatestVersion })
  const events: string[] = []
  let cachedVersion: string | undefined
  environment.observePreparation = vi.fn(async (stage: string) => {
    if (stage === 'redis-start') return { port: 12345, redis: {} }
    if (stage === 'mysql-start') return { databaseUrl: 'mysql://fixture' }
    if (stage === 'admin-auth-setup') return { access_token: 'fixture-token' }
  })
  environment.reserveBackendPorts = vi.fn(async () => {})
  environment.setExecutorLatestVersion = vi.fn(async (version: string) => {
    events.push('seed')
    cachedVersion = version
  })
  environment.launchBackend = vi.fn(async () => {
    events.push(cachedVersion ? 'launch-with-cache' : 'launch-with-cold-refresh')
  })
  return { environment, events, cachedVersion: () => cachedVersion }
}

test('lifecycle version data is present before Backend can enqueue a cold-cache refresh', async () => {
  try {
    const { environment, events, cachedVersion } = prepareBackend('999.0.0')
    await environment.startBackend()
    expect(events).toEqual(['seed', 'launch-with-cache'])
    expect(cachedVersion()).toBe('999.0.0')
    expect(environment.setExecutorLatestVersion).toHaveBeenCalledExactlyOnceWith('999.0.0')
  } finally {
    vi.restoreAllMocks()
  }
})

test('other cloud checkpoints retain their existing version preparation', async () => {
  try {
    const { environment, events } = prepareBackend()
    await environment.startBackend()
    expect(events).toEqual(['launch-with-cold-refresh'])
    expect(environment.setExecutorLatestVersion).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

test('failed version seeding stops preparation before Backend is launched', async () => {
  try {
    const { environment } = prepareBackend('999.0.0')
    const failure = new Error('Redis fixture write failed')
    environment.setExecutorLatestVersion.mockRejectedValue(failure)
    await expect(environment.startBackend()).rejects.toBe(failure)
    expect(environment.launchBackend).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})
