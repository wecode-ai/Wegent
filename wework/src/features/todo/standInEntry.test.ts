import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import { parseStandInEntry, resolveStandInEntry } from './standInEntry'
import { useStandInEntry } from './useStandInEntry'

const binding = { userId: 7, deviceId: 'primary', backendUrl: 'https://wework.example' }

function profile(deviceId: string, ...roles: string[]): PersonalStandInSettings {
  return {
    userId: binding.userId,
    executionDeviceId: deviceId,
    version: 1,
    roles: roles.map(id => newStandInRole(deviceId, id)),
  }
}

function fixture(settings = [profile('primary'), profile('remote', 'reviewer')]) {
  return {
    personalGet: vi.fn(async (_owner: number, deviceId: string) => {
      const value = settings.find(settings => settings.executionDeviceId === deviceId)
      if (!value) throw new Error('unavailable')
      return value
    }),
  }
}

function resolve(query: string, api = fixture(), devices = ['remote']) {
  const entry = parseStandInEntry(`/stand-in?${query}`)
  if (entry.kind !== 'identity') throw new Error('Expected an identity link')
  return resolveStandInEntry(api, entry, binding, new Set(devices))
}

describe('stand-in entry links', () => {
  it('preserves an open settings target during inventory refresh and still rejects a removed device', async () => {
    const api = fixture()
    const route = '/stand-in?deviceId=remote&profileId=reviewer&settingsRequest=1'
    const { result, rerender } = renderHook(
      ({ devices }) => useStandInEntry(route, api, binding, devices, true),
      { initialProps: { devices: new Set(['remote', 'other']) } }
    )
    const authorized = { kind: 'ready', deviceId: 'remote', profileId: 'reviewer' }
    await waitFor(() => expect(result.current.result).toEqual(authorized))
    rerender({ devices: new Set(['other', 'remote']) })
    expect(result.current.result).toEqual(authorized)
    expect(api.personalGet).toHaveBeenCalledTimes(1)

    rerender({ devices: new Set(['other']) })
    expect(result.current.result).toBeUndefined()
    await waitFor(() =>
      expect(result.current.result).toEqual({ kind: 'error', error: 'forbidden' })
    )
    expect(api.personalGet).toHaveBeenCalledTimes(1)
  })

  it('keeps the verified settings target mounted while returning to the same tab', async () => {
    const api = fixture()
    const devices = new Set(['remote'])
    const route = '/stand-in?deviceId=remote&profileId=reviewer&settingsRequest=1'
    const { result, rerender } = renderHook(
      ({ active, request }) =>
        useStandInEntry(route, api, { ...binding }, devices, active, request),
      { initialProps: { active: true, request: 1 } }
    )
    const authorized = { kind: 'ready', deviceId: 'remote', profileId: 'reviewer' }
    await waitFor(() => expect(result.current.result).toEqual(authorized))
    api.personalGet.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Permission revoked'), { code: 'permission_denied' })
    })

    rerender({ active: false, request: 1 })
    rerender({ active: true, request: 2 })

    expect(result.current.result).toEqual(authorized)
    await waitFor(() =>
      expect(result.current.result).toEqual({ kind: 'error', error: 'forbidden' })
    )
  })

  it('keeps an assistant settings request and a conversation target distinct', () => {
    expect(parseStandInEntry('/stand-in?view=messages')).toEqual({ kind: 'home', scheduled: false })
    expect(
      parseStandInEntry('/stand-in?profileId=reviewer&deviceId=remote&settingsRequest=1')
    ).toEqual({
      kind: 'identity',
      profileId: 'reviewer',
      deviceId: 'remote',
      settingsRequest: '1',
      scheduled: false,
    })
    expect(parseStandInEntry('/stand-in?assistantDeviceId=remote&assistantTaskId=chat')).toEqual({
      kind: 'conversation',
      deviceId: 'remote',
      taskId: 'chat',
    })
  })

  it.each([
    ['settingsRequest=1', 'missing_identity'],
    ['profileId=one&profileId=two', 'conflict'],
    ['deviceId=', 'conflict'],
    ['assistantTaskId=chat', 'unsupported'],
    ['view=messages&profileId=reviewer', 'unsupported'],
    ['assistantDeviceId=remote&assistantTaskId=chat&profileId=reviewer', 'unsupported'],
  ])('rejects %s as %s before loading a profile', (query, error) => {
    expect(parseStandInEntry(`/stand-in?${query}`)).toEqual({ kind: 'error', error })
  })

  it('opens only the uniquely identified assistant for profile, device and paired links', async () => {
    const reviewer = { kind: 'ready', deviceId: 'remote', profileId: 'reviewer' }
    await expect(resolve('deviceId=remote&profileId=reviewer&settingsRequest=1')).resolves.toEqual(
      reviewer
    )
    await expect(resolve('profileId=reviewer')).resolves.toEqual(reviewer)
    await expect(resolve('deviceId=remote')).resolves.toEqual(reviewer)
    await expect(resolve('profileId=%40primary')).resolves.toEqual({
      kind: 'ready',
      deviceId: 'primary',
      profileId: '@primary',
    })
  })

  it.each([
    ['deviceId=primary&profileId=reviewer', 'conflict'],
    ['deviceId=remote&profileId=%40primary', 'conflict'],
    ['deviceId=remote&profileId=removed', 'not_found'],
    ['deviceId=other', 'forbidden'],
    ['deviceId=remote&userId=8', 'forbidden'],
  ])('keeps the binding on %s', async (query, error) => {
    await expect(resolve(query)).resolves.toEqual({ kind: 'error', error })
  })

  it('does not guess when a device or profile matches multiple assistants', async () => {
    const api = fixture([profile('primary', 'reviewer'), profile('remote', 'reviewer', 'writer')])
    for (const query of ['deviceId=primary', 'deviceId=remote', 'profileId=reviewer'])
      await expect(resolve(query, api)).resolves.toEqual({ kind: 'error', error: 'ambiguous' })
    await expect(resolve('deviceId=primary&profileId=%40primary', api)).resolves.toEqual({
      kind: 'ready',
      deviceId: 'primary',
      profileId: '@primary',
    })
    api.personalGet.mockClear()
    await expect(resolve('deviceId=remote&profileId=reviewer', api)).resolves.toEqual({
      kind: 'ready',
      deviceId: 'remote',
      profileId: 'reviewer',
    })
    expect(api.personalGet).toHaveBeenCalledExactlyOnceWith(7, 'remote')
  })

  it('never requests another owner or an unrecognized device', async () => {
    const api = fixture()
    await resolve('deviceId=remote&userId=8', api)
    await resolve('deviceId=unknown', api)
    expect(api.personalGet).not.toHaveBeenCalled()
  })

  it('resolves only the exact authorized active role while the primary is stopped', async () => {
    const api = fixture([profile('primary', 'reviewer'), profile('remote', 'reviewer')])
    const verifyIndependentDevice = vi.fn(async () => true)
    const entry = parseStandInEntry('/stand-in?deviceId=remote&profileId=reviewer')
    if (entry.kind !== 'identity') throw new Error('Expected an identity link')
    const resolveIndependent = () =>
      resolveStandInEntry(api, entry, binding, new Set(['remote']), { verifyIndependentDevice })
    await expect(resolveIndependent()).resolves.toEqual({
      kind: 'ready',
      deviceId: 'remote',
      profileId: 'reviewer',
    })
    expect(api.personalGet).toHaveBeenCalledExactlyOnceWith(7, 'remote')
    expect(verifyIndependentDevice).toHaveBeenCalledExactlyOnceWith('remote', 'reviewer')

    verifyIndependentDevice.mockResolvedValueOnce(false)
    await expect(resolveIndependent()).resolves.toEqual({ kind: 'error', error: 'not_found' })
    for (const status of ['stopping', 'stopped'] as const) {
      api.personalGet.mockResolvedValueOnce({
        ...profile('remote', 'reviewer'),
        lifecycle: { status },
      })
      await expect(resolveIndependent()).resolves.toEqual({ kind: 'error', error: 'not_found' })
    }
    api.personalGet.mockResolvedValueOnce({ ...profile('remote', 'reviewer'), userId: 8 })
    await expect(resolveIndependent()).resolves.toEqual({ kind: 'error', error: 'forbidden' })
    expect(api.personalGet.mock.calls.every(([, device]) => device === 'remote')).toBe(true)
  })

  it('does not fall back to any other device for an incomplete or mismatched independent role link', async () => {
    const api = fixture()
    const verifyIndependentDevice = vi.fn(async () => true)
    for (const query of [
      'profileId=reviewer',
      'deviceId=remote',
      'deviceId=primary&profileId=reviewer',
      'deviceId=primary&profileId=%40primary',
    ]) {
      const entry = parseStandInEntry('/stand-in?' + query)
      if (entry.kind !== 'identity') throw new Error('Expected an identity link')
      await expect(
        resolveStandInEntry(api, entry, binding, new Set(['remote']), { verifyIndependentDevice })
      ).resolves.toEqual({ kind: 'error', error: 'not_found' })
    }
    const unknown = parseStandInEntry('/stand-in?deviceId=unknown&profileId=reviewer')
    if (unknown.kind !== 'identity') throw new Error('Expected an identity link')
    await expect(
      resolveStandInEntry(api, unknown, binding, new Set(['remote']), { verifyIndependentDevice })
    ).resolves.toEqual({ kind: 'error', error: 'forbidden' })
    expect(api.personalGet).not.toHaveBeenCalled()
    const missing = parseStandInEntry('/stand-in?deviceId=remote&profileId=missing')
    if (missing.kind !== 'identity') throw new Error('Expected an identity link')
    await expect(
      resolveStandInEntry(api, missing, binding, new Set(['remote']), { verifyIndependentDevice })
    ).resolves.toEqual({ kind: 'error', error: 'not_found' })
    expect(api.personalGet).toHaveBeenCalledExactlyOnceWith(7, 'remote')
  })

  it('invalidates a verified independent link when its stop state changes', async () => {
    const api = fixture()
    const verifyIndependentDevice = vi.fn(async () => true)
    const route = '/stand-in?deviceId=remote&profileId=reviewer'
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useStandInEntry(
          route,
          api,
          binding,
          new Set(['remote']),
          true,
          1,
          verifyIndependentDevice,
          scope
        ),
      { initialProps: { scope: 'clear' } }
    )
    await waitFor(() =>
      expect(result.current.result).toEqual({
        kind: 'ready',
        deviceId: 'remote',
        profileId: 'reviewer',
      })
    )
    verifyIndependentDevice.mockResolvedValueOnce(false)
    rerender({ scope: 'pending' })
    expect(result.current.result).toBeUndefined()
    await waitFor(() =>
      expect(result.current.result).toEqual({ kind: 'error', error: 'not_found' })
    )
  })

  it('handles incomplete and unauthorized lookups without using the successful response', async () => {
    const api = fixture()
    api.personalGet.mockRejectedValueOnce(new Error('offline'))
    await expect(resolve('profileId=reviewer', api)).resolves.toEqual({
      kind: 'error',
      error: 'lookup_failed',
    })
    api.personalGet.mockRejectedValueOnce({ code: 'permission_denied' })
    await expect(resolve('profileId=reviewer', api)).resolves.toEqual({
      kind: 'error',
      error: 'forbidden',
    })
    api.personalGet.mockResolvedValueOnce({ ...profile('primary'), userId: 8 })
    await expect(resolve('profileId=%40primary', api)).resolves.toEqual({
      kind: 'error',
      error: 'forbidden',
    })
  })
})
