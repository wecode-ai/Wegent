import { newStandInRole, type StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { describe, expect, it, vi } from 'vitest'
import { standInProfile } from './personalStandInSettings.testFixtures'
import { PersonalAssistantSavePreflightError } from './personalAssistantDeviceSettings'
import { saveStandInRoleDevice } from './saveStandInRoleDevice'

const connection: StandInSourceConnection = {
  providerId: '@wegent/dsh-connection-git/github',
  profile: 'account',
  kind: 'repository',
  id: 'repo',
  name: 'owner/repo',
  subscriptionId: 'subscription',
  generation: 'generation',
  boundary: { partition: 'source', sequence: 20 },
  policy: { automatic: true, askBeforeAct: true },
}

function fixture(status: string) {
  const role = { ...newStandInRole('source', 'role'), enabled: true, connections: [connection] }
  const source = standInProfile('source', [role])
  const target = standInProfile('target', [])
  const save = vi.fn<StandInExecutorApi['personalSave']>(async (_user, profile) => profile)
  const api = {
    personalGet: async (_user: number, device: string) => (device === 'target' ? target : source),
    personalSave: save,
    connectionProviders: async () => ({
      items: [{ id: connection.providerId, availability: { status } }],
    }),
  } as unknown as StandInExecutorApi
  const move = () =>
    saveStandInRoleDevice(api, {
      userId: 7,
      sourceDevice: 'source',
      source,
      draft: source,
      role: { ...role, executionDeviceId: 'target' },
    })
  return { move, save }
}

describe('moving a role with a bound webhook', () => {
  it('claims the subscription generation after redirecting intake and drops the source cursor', async () => {
    const { move, save } = fixture('ready')
    const moved = await move()
    expect(save.mock.calls.map(call => call[2])).toEqual(['target', 'source', 'target'])
    expect(save.mock.calls[0][1].roles[0].connections?.[0].pendingTakeover).toBeUndefined()
    expect(moved.connections?.[0]).toMatchObject({
      subscriptionId: 'subscription',
      generation: 'generation',
      pendingTakeover: true,
      resumePending: true,
      policy: connection.policy,
    })
    expect(moved.connections?.[0].boundary).toBeUndefined()
  })

  it('restores source intake after a webhook activation fails before writing', async () => {
    const { move, save } = fixture('ready')
    save.mockImplementationOnce(async (_user, profile) => profile)
    save.mockImplementationOnce(async (_user, profile) => profile)
    save.mockRejectedValueOnce(new PersonalAssistantSavePreflightError('Target read failed'))
    await expect(move()).rejects.toThrow('Target read failed')
    expect(save.mock.calls.map(call => call[2])).toEqual(['target', 'source', 'target', 'source'])
    expect(save.mock.calls.at(-1)?.[1].roles[0]).toMatchObject({
      enabled: true,
      executionDeviceId: 'source',
      connections: [connection],
    })
  })

  it('keeps the source receiver when the destination requires authorization', async () => {
    const { move, save } = fixture('auth_required')
    await expect(move()).rejects.toMatchObject({ code: 'stand_in_target_connection_unavailable' })
    expect(save).not.toHaveBeenCalled()
  })
})
