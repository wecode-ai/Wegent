import { describe, expect, test, vi } from 'vitest'
import {
  HOST_CAPABILITIES,
  HostCapabilityError,
  HostCapabilityRouter,
} from './capability-router.js'

describe('HostCapabilityRouter', () => {
  test('keeps route tokens exclusively in the Host lifecycle owner', () => {
    expect(HOST_CAPABILITIES).toContain('smartApps.open')
    for (const name of [
      'storeProxyToken',
      'takeProxyToken',
      'storeAdditionalProxyTokens',
      'takeAdditionalProxyTokens',
      'storeContextToken',
      'takeContextToken',
      'storeDecisionToken',
      'takeDecisionToken',
    ])
      expect(HOST_CAPABILITIES).not.toContain(`smartApps.${name}`)
  })

  test('dispatches only explicitly granted capabilities', async () => {
    const router = new HostCapabilityRouter()
    const handler = vi.fn(async params => ({ echoed: params.value }))
    router.register('window.getState', handler)
    router.grant('@wegent/dsh-app-wework', ['window.getState'])

    await expect(
      router.invoke('@wegent/dsh-app-wework', 'window.getState', { value: 1 })
    ).resolves.toEqual({ echoed: 1 })
    await expect(router.invoke('@third-party/app', 'window.getState', {})).rejects.toMatchObject<
      Partial<HostCapabilityError>
    >({
      code: 'capability_denied',
    })
    await expect(
      router.invoke('@wegent/dsh-app-wework', 'process.spawn', {})
    ).rejects.toMatchObject<Partial<HostCapabilityError>>({
      code: 'unknown_capability',
    })
    expect(handler).toHaveBeenCalledOnce()
  })
})
