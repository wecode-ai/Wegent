// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { teamApis } from '@/apis/team'
import { useTeamLeaderBot } from '@/features/settings/hooks/useTeamLeaderBot'
import { isRetainedPrivateModel } from '@/features/settings/components/team-edit/model-select-utils'
import type { Bot, Team } from '@/types/api'

jest.mock('@/apis/team', () => ({
  teamApis: { getTeam: jest.fn() },
}))

const getTeam = jest.mocked(teamApis.getTeam)
const privateBot: Bot = {
  id: 7,
  name: 'creator-private-bot',
  namespace: 'default',
  skills: ['creator-private-skill'],
  skill_refs: {
    'creator-private-skill': { skill_id: 13, namespace: 'default', is_public: false },
  },
  preload_skills: ['creator-private-skill'],
  agent_config: { bind_model: 'creator-private-model', bind_model_type: 'user' },
  system_prompt: 'Original creator prompt',
  shell_name: 'Chat',
  shell_type: 'Chat',
  mcp_servers: {},
  is_active: true,
  created_at: '2026-11-12T00:00:00Z',
  updated_at: '2026-11-12T00:00:00Z',
}
const team = {
  id: 17,
  namespace: 'editor-group',
  user_id: 11,
  bots: [{ bot_id: privateBot.id, role: 'leader' }],
} as Team
const detail = {
  ...team,
  bots: [{ ...team.bots[0], bot: privateBot }],
}

describe('useTeamLeaderBot', () => {
  beforeEach(() => {
    getTeam.mockReset()
  })

  it('loads the private leader through its Team and retains full persisted configuration', async () => {
    getTeam.mockResolvedValue(detail)
    const { result } = renderHook(() => useTeamLeaderBot(team, [], true))
    expect(result.current.pending).toBe(true)

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(getTeam).toHaveBeenCalledWith(team.id, expect.any(AbortSignal))
    expect(result.current.bot).toEqual(privateBot)
    expect(result.current.bot?.name).toBe('creator-private-bot')
    expect(result.current.bot?.skills).toEqual(['creator-private-skill'])
    expect(result.current.bot?.skill_refs).toEqual(privateBot.skill_refs)
    expect(result.current.bot?.preload_skills).toEqual(privateBot.preload_skills)
    expect(result.current.bot?.agent_config).toEqual(privateBot.agent_config)
  })

  it('does not load unopened editors or duplicate an available catalog definition', () => {
    const { result, rerender } = renderHook(
      ({ enabled, bots }) => useTeamLeaderBot(team, bots, enabled),
      { initialProps: { enabled: false, bots: [] as Bot[] } }
    )
    expect(result.current.pending).toBe(false)
    expect(getTeam).not.toHaveBeenCalled()
    rerender({ enabled: true, bots: [privateBot] })
    expect(result.current.bot).toBe(privateBot)
    expect(result.current.pending).toBe(false)
    expect(getTeam).not.toHaveBeenCalled()
  })

  it('keeps saving blocked on denial and supports an explicit reload', async () => {
    getTeam.mockRejectedValueOnce(new Error('Access denied')).mockResolvedValueOnce(detail)
    const { result } = renderHook(() => useTeamLeaderBot(team, [], true))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.pending).toBe(true)
    expect(result.current.bot).toBeUndefined()

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.failed).toBe(false)
    expect(result.current.bot).toEqual(privateBot)
    expect(getTeam).toHaveBeenCalledTimes(2)
  })

  it('does not accept a different Bot identity from the Team response', async () => {
    const wrongIdentity = {
      ...detail,
      bots: [{ ...team.bots[0], bot: { ...privateBot, id: 99 } }],
    }
    getTeam.mockResolvedValue(wrongIdentity)
    const { result } = renderHook(() => useTeamLeaderBot(team, [], true))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.pending).toBe(true)
    expect(result.current.bot).toBeUndefined()
  })

  it('discards an old response after switching or closing the editor', async () => {
    let resolve!: (value: Team) => void
    getTeam.mockReturnValueOnce(new Promise(value => (resolve = value)))
    const nextTeam = { ...team, id: 18 }
    const nextBot = { ...privateBot, name: 'next-private-bot' }
    getTeam.mockResolvedValueOnce({
      ...nextTeam,
      bots: [{ ...team.bots[0], bot: nextBot }],
    })
    const { result, rerender } = renderHook(
      ({ selected, enabled }) => useTeamLeaderBot(selected, [], enabled),
      { initialProps: { selected: team, enabled: true } }
    )
    const oldSignal = getTeam.mock.calls[0][1]!
    rerender({ selected: nextTeam, enabled: true })
    expect(oldSignal.aborted).toBe(true)
    await waitFor(() => expect(result.current.bot).toEqual(nextBot))
    await act(async () => resolve(detail))
    expect(result.current.bot).toEqual(nextBot)

    rerender({ selected: nextTeam, enabled: false })
    expect(result.current.bot).toBeUndefined()
    expect(result.current.pending).toBe(false)
  })
})

describe('private model retention', () => {
  it.each([
    {
      name: 'creator-private-model',
      type: 'user',
      namespace: 'default',
      shell: 'Chat',
      retained: true,
    },
    {
      name: 'new-private-model',
      type: 'user',
      namespace: 'default',
      shell: 'Chat',
      retained: false,
    },
    {
      name: 'creator-private-model',
      type: 'public',
      namespace: 'default',
      shell: 'Chat',
      retained: false,
    },
    {
      name: 'creator-private-model',
      type: 'user',
      namespace: 'other-group',
      shell: 'Chat',
      retained: false,
    },
    {
      name: 'creator-private-model',
      type: 'user',
      namespace: 'default',
      shell: 'ClaudeCode',
      retained: false,
    },
  ] as const)('retains only the exact existing private selection: %j', selection => {
    expect(
      isRetainedPrivateModel(
        privateBot,
        selection.name,
        selection.type,
        selection.namespace,
        selection.shell
      )
    ).toBe(selection.retained)
  })

  it('does not classify a missing definition or a public model as private retention', () => {
    for (const bot of [
      undefined,
      {
        ...privateBot,
        agent_config: { bind_model: 'creator-private-model', bind_model_type: 'public' },
      },
    ]) {
      expect(isRetainedPrivateModel(bot, 'creator-private-model', 'user', 'default', 'Chat')).toBe(
        false
      )
    }
  })
})
