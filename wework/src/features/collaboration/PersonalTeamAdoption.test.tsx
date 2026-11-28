import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { PersonalTeamAdoption } from './PersonalTeamAdoption'

test('selects the owner’s Team by resource identity and validates the device execution definition', async () => {
  const user = userEvent.setup()
  const team = {
    id: 'my-team',
    name: 'Review team',
    leadId: '@primary',
    members: { '@primary': 'review', audit: 'verify' },
  }
  const exported = { name: 'Review', collaboration_model: 'solo', bot: [{ id: 'review-bot' }] }
  const profile: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'cloud-device',
    version: 2,
    roles: [],
    teams: [team],
  }
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>(async (owner, device, options) => {
    expect([owner, device]).toEqual([7, 'cloud-device'])
    return options?.exportTeamRoleId ? { ...profile, portableTeam: exported } : profile
  })
  const reference = { name: 'review', namespace: 'personal-assistant' }
  const adopt = vi.fn().mockResolvedValue(undefined)
  render(
    <PersonalTeamAdoption
      projectId="project"
      location="cloud"
      agents={[
        { id: 'wrong', name: 'Review', team_id: 9 },
        { id: 'correct', name: 'Review', team_id: 10 },
        { id: 'account-auditor', name: 'Audit', team_id: 11 },
      ]}
      userId={7}
      api={{ binding: vi.fn(), personalGet }}
      identity={async () => null}
      accountApi={{
        get: async () => ({
          revision: '1',
          defaultTeamRef: reference,
          retiredRoleIds: [],
          definitions: [
            {
              roleId: 'audit',
              team: {
                metadata: { ...reference, name: 'audit' },
                spec: { collaborationModel: 'solo', members: [] },
              },
              bot: { metadata: reference },
              ghost: { spec: { systemPrompt: '' } },
            },
            {
              roleId: '@primary',
              team: { metadata: reference, spec: { collaborationModel: 'solo', members: [] } },
              bot: {
                metadata: reference,
                spec: { execution_policy: { mode: 'fixed', environment_id: 'cloud-device' } },
              },
              ghost: { spec: { systemPrompt: '' } },
            },
          ],
        }),
      }}
      agentApi={{
        getTeamIdentity: async id => ({
          ...reference,
          name: id === 11 ? 'audit' : reference.name,
          id,
          userId: id === 9 ? 8 : 7,
        }),
      }}
      adopt={adopt}
    />
  )
  await user.click(screen.getByTestId('project-personal-team-open'))
  await user.click(await screen.findByTestId('project-personal-team-select'))
  await user.click(await screen.findByTestId('project-personal-team-select-option-my-team'))
  expect(screen.getByTestId('project-personal-team-member-@primary')).toHaveTextContent('correct')
  await user.click(screen.getByTestId('project-personal-team-adopt'))
  await waitFor(() =>
    expect(adopt).toHaveBeenCalledWith({
      definition: team,
      memberAgentIds: { '@primary': 'correct', audit: 'account-auditor' },
      memberSourceTeamIds: { audit: 11 },
      memberTeamDefinitions: { '@primary': exported },
    })
  )
})

test('adopts a local workspace Team offline using its exact project Agent binding', async () => {
  const user = userEvent.setup()
  const team = {
    id: 'local-team',
    name: 'QA',
    leadId: '@primary',
    members: { '@primary': 'review' },
  }
  const profile: PersonalStandInSettings = {
    userId: 0,
    executionDeviceId: 'local',
    version: 3,
    roles: [],
    primary: { enabled: true, prompt: '', preferences: '', teamRef: 'LA-source' },
    teams: [team],
  }
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>(async (owner, device, options) => {
    expect([owner, device, options]).toEqual([0, 'local', { deviceSettingsOnly: true }])
    return profile
  })
  const accountGet = vi.fn()
  const adopt = vi.fn().mockResolvedValue(undefined)
  render(
    <PersonalTeamAdoption
      projectId="project"
      location="local"
      userId={0}
      identity={async () => ({
        deviceId: 'local',
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      })}
      agents={[
        { id: 'LA-other', name: 'QA' },
        { id: 'LA-source', name: 'QA' },
      ]}
      accountApi={{ get: accountGet }}
      api={{ binding: vi.fn(), personalGet }}
      adopt={adopt}
    />
  )
  await user.click(screen.getByTestId('project-personal-team-open'))
  await user.click(await screen.findByTestId('project-personal-team-select'))
  await user.click(await screen.findByTestId('project-personal-team-select-option-local-team'))
  expect(screen.getByTestId('project-personal-team-member-@primary')).toHaveTextContent('LA-source')
  await user.click(screen.getByTestId('project-personal-team-adopt'))
  await waitFor(() =>
    expect(adopt).toHaveBeenCalledWith({
      sourceOwnerId: 0,
      definition: team,
      memberAgentIds: { '@primary': 'LA-source' },
      memberTeamDefinitions: {},
    })
  )
  expect(accountGet).not.toHaveBeenCalled()
})
