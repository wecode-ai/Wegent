import { describe, expect, it, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import { parseStandInEntry, resolveStandInEntry } from './standInEntry'

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
    for (const query of ['deviceId=remote', 'profileId=reviewer'])
      await expect(resolve(query, api)).resolves.toEqual({ kind: 'error', error: 'ambiguous' })
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
