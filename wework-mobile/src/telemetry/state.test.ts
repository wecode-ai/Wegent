import { describe, expect, it } from 'vitest'
import {
  beginForeground,
  EMPTY_MOBILE_TELEMETRY_STATE,
  endForeground,
  heartbeatForeground,
  parseMobileTelemetryState,
  prepareLaunch,
  resetTelemetryIdentity,
  serializeMobileTelemetryState,
  type MobileTelemetryState,
  type MobileTelemetryStateStorage,
} from './state'
import { MobileTelemetryStateStore } from './stateStore'

function memoryStorage(initial: string | null = null) {
  let value = initial
  const storage: MobileTelemetryStateStorage & { writes: string[]; quarantineCalls: number } = {
    quarantineCalls: 0,
    writes: [],
    read: async () => value,
    write: async next => {
      value = next
      storage.writes.push(next)
    },
  }
  return storage
}

describe('mobile telemetry state', () => {
  it('creates one installation identity and reports later version changes', () => {
    const first = prepareLaunch(EMPTY_MOBILE_TELEMETRY_STATE, '1.0.0', 1_000, () => 'install_123')
    expect(first.installationEvent).toBe('installed')
    expect(first.isFirstLaunch).toBe(true)
    expect(first.state).toMatchObject({
      installationId: 'install_123',
      installedAt: 1_000,
      lastSeenAppVersion: '1.0.0',
      launchCount: 1,
      foregroundStartedAt: 1_000,
    })
    const updated = prepareLaunch(first.state, '1.1.0', 2_000, () => 'unused_install')
    expect(updated.installationEvent).toBe('updated')
    expect(updated.previousVersion).toBe('1.0.0')
    expect(updated.state.installationId).toBe('install_123')
    expect(updated.state.launchCount).toBe(2)
  })

  it('measures a previous foreground period from its last heartbeat', () => {
    const active = {
      ...EMPTY_MOBILE_TELEMETRY_STATE,
      installationId: 'install_123',
      installedAt: 1_000,
      sampleBucket: 0.2,
      lastSeenAppVersion: '1.0.0',
      launchCount: 1,
      foregroundStartedAt: 10_000,
      foregroundHeartbeatAt: 40_000,
    }
    const next = prepareLaunch(active, '1.0.0', 70_000, () => 'unused_install')
    expect(next.previousForegroundDurationMs).toBe(30_000)
    expect(next.installationEvent).toBeNull()
  })

  it('tracks foreground duration and keeps the last heartbeat', () => {
    const started = beginForeground(EMPTY_MOBILE_TELEMETRY_STATE, 1_000)
    const heartbeat = heartbeatForeground(started, 9_000)
    expect(heartbeat.foregroundHeartbeatAt).toBe(9_000)
    expect(endForeground(heartbeat, 12_000)).toMatchObject({
      durationMs: 11_000,
      state: { foregroundStartedAt: null, foregroundHeartbeatAt: null },
    })
  })

  it('resets anonymous identity without losing the saved consent decision', () => {
    const state: MobileTelemetryState = {
      ...EMPTY_MOBILE_TELEMETRY_STATE,
      consentAsked: true,
      consentEnabled: false,
      installationId: 'install_123',
      installedAt: 1_000,
      sampleBucket: 0.5,
      lastSeenAppVersion: '1.0.0',
      launchCount: 3,
    }
    expect(resetTelemetryIdentity(state)).toMatchObject({
      consentAsked: true,
      consentEnabled: false,
      installationId: null,
      installedAt: null,
      sampleBucket: null,
      launchCount: 0,
    })
  })

  it('rejects corrupt state instead of treating it as consent', () => {
    expect(() => parseMobileTelemetryState('{bad json')).toThrow('Invalid mobile telemetry state')
    expect(() => parseMobileTelemetryState('{"version":1,"consentAsked":"false"}')).toThrow(
      'Invalid mobile telemetry state field'
    )
  })

  it('quarantines invalid state and asks for consent again with a default state', async () => {
    const storage = memoryStorage('{bad json')
    storage.quarantine = async () => {
      storage.quarantineCalls += 1
    }
    storage.quarantineCalls = 0
    const store = new MobileTelemetryStateStore(storage)
    await expect(store.load()).resolves.toEqual(EMPTY_MOBILE_TELEMETRY_STATE)
    expect(storage.quarantineCalls).toBe(1)
  })

  it('allows a failed storage read to be retried', async () => {
    let reads = 0
    const store = new MobileTelemetryStateStore({
      read: async () => {
        reads += 1
        if (reads === 1) throw new Error('storage unavailable')
        return null
      },
      write: async () => undefined,
    })
    await expect(store.load()).rejects.toThrow('storage unavailable')
    await expect(store.load()).resolves.toEqual(EMPTY_MOBILE_TELEMETRY_STATE)
  })

  it('serializes concurrent state updates through one writer', async () => {
    const storage = memoryStorage(serializeMobileTelemetryState(EMPTY_MOBILE_TELEMETRY_STATE))
    const store = new MobileTelemetryStateStore(storage)
    await Promise.all([
      store.update(state => ({
        state: { ...state, consentAsked: true },
        result: null,
      })),
      store.update(state => ({
        state: { ...state, consentEnabled: true },
        result: null,
      })),
    ])
    expect(storage.writes).toHaveLength(2)
    expect(parseMobileTelemetryState(storage.writes.at(-1)!)).toMatchObject({
      consentAsked: true,
      consentEnabled: true,
    })
  })
})
