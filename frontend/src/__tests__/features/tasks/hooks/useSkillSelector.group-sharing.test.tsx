// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import { fetchTeamSkills, type TeamSkillsResponse } from '@/apis/team'
import type { SkillRef, Team } from '@/types/api'
import { useSkillSelector } from '@/features/tasks/hooks/useSkillSelector'

jest.mock('@/apis/skills', () => ({ fetchUnifiedSkillsList: jest.fn() }))
jest.mock('@/apis/team', () => ({ fetchTeamSkills: jest.fn() }))
jest.mock('@/features/tasks/service/messageService', () => ({ isChatShell: () => false }))

it('sends the original ID and namespace when selecting another member’s shared skill', async () => {
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([
    {
      id: 275472,
      name: 'ps-agent-recagent',
      namespace: 'default',
      description: 'Shared analysis',
      user_id: 4239,
      is_group_shared: true,
      is_public: false,
      is_active: true,
      availability: { inMyDefault: false },
    },
  ])
  const { result } = renderHook(() => useSkillSelector({ team: null }))
  await waitFor(() => expect(result.current.temporarySkills).toHaveLength(1))

  act(() => result.current.toggleSkill(result.current.temporarySkills[0]))

  expect(result.current.selectedSkills).toEqual([
    { skill_id: 275472, name: 'ps-agent-recagent', namespace: 'default', is_public: false },
  ])
})

it('keeps the clicked same-name skill identity and replaces it when another is selected', async () => {
  const personal = {
    id: 1,
    name: 'pdf',
    namespace: 'default',
    description: '',
    user_id: 1,
    is_public: false,
    is_active: true,
  }
  const shared = { ...personal, id: 2, namespace: 'engineering' }
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([personal, shared])
  const { result } = renderHook(() => useSkillSelector({ team: null }))
  await waitFor(() => expect(result.current.temporarySkills).toHaveLength(2))
  act(() => result.current.toggleSkill(shared))
  expect(result.current.selectedSkills).toEqual([
    { skill_id: 2, name: 'pdf', namespace: 'engineering', is_public: false },
  ])
  act(() => result.current.toggleSkill(personal))
  expect(result.current.selectedSkills).toEqual([
    { skill_id: 1, name: 'pdf', namespace: 'default', is_public: false },
  ])
  act(() => result.current.toggleSkill(personal))
  expect(result.current.selectedSkills).toEqual([])
})

it('can deselect an ID-less stored skill with same-name catalog entries', async () => {
  const skill = {
    id: 3,
    name: 'pdf',
    namespace: 'engineering',
    description: '',
    user_id: 1,
    is_public: false,
    is_active: true,
  }
  const personal = { ...skill, id: 5, namespace: 'default' }
  const publicSkill = { ...skill, id: 6, is_public: true }
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([personal, publicSkill, skill])
  const initialSelectedSkills = [
    { skill_id: null, name: 'pdf', namespace: 'engineering', is_public: false },
  ]
  const { result } = renderHook(() => useSkillSelector({ team: null, initialSelectedSkills }))
  await waitFor(() => expect(result.current.selectedSkills[0].skill_id).toBe(3))
  act(() => result.current.toggleSkill(skill))
  expect(result.current.selectedSkills).toEqual([])
})

it('retains an ID-less stored reference when only a different namespace is available', async () => {
  const saved = { skill_id: null, name: 'pdf', namespace: 'engineering', is_public: false }
  const skill = {
    id: 6,
    name: saved.name,
    namespace: 'default',
    description: '',
    user_id: 1,
    is_public: false,
    is_active: true,
  }
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([skill])
  const { result } = renderHook(() =>
    useSkillSelector({ team: null, initialSelectedSkills: [saved] })
  )
  await waitFor(() => expect(result.current.availableSkills).toEqual([skill]))
  expect(result.current.selectedSkills).toEqual([saved])

  act(() => result.current.setSelectedSkillNames([skill.name]))
  expect(result.current.selectedSkills).toEqual([
    { skill_id: skill.id, name: skill.name, namespace: skill.namespace, is_public: false },
  ])
})

it('keeps an explicit selection through catalog loading and task refresh, and clears it for another task', async () => {
  const skill = {
    id: 4,
    name: 'pdf',
    namespace: 'default',
    description: '',
    user_id: 1,
    is_public: false,
    is_active: true,
  }
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([skill])
  let resolveTeamSkills!: (data: TeamSkillsResponse) => void
  jest.mocked(fetchTeamSkills).mockReturnValue(
    new Promise(resolve => {
      resolveTeamSkills = resolve
    })
  )
  const team = { id: 10 } as Team
  const saved: SkillRef = { name: 'text', namespace: 'default', is_public: false }
  const { result, rerender } = renderHook(
    ({ taskId, initialSelectedSkills }) =>
      useSkillSelector({ team, taskId, initialSelectedSkills }),
    { initialProps: { taskId: 20, initialSelectedSkills: [saved] } }
  )
  await waitFor(() => expect(result.current.availableSkills).toEqual([skill]))
  act(() => result.current.toggleSkill(skill))
  await act(async () =>
    resolveTeamSkills({
      team_id: team.id,
      team_namespace: 'default',
      skills: [skill.name],
      preload_skills: [],
    })
  )
  expect(result.current.teamSkillNames).toEqual([skill.name])
  const expected = [saved, { skill_id: 4, name: 'pdf', namespace: 'default', is_public: false }]
  expect(result.current.selectedSkills).toEqual(expected)
  rerender({ taskId: 20, initialSelectedSkills: [{ ...saved, skill_id: null }] })
  expect(result.current.selectedSkills).toEqual(expected)
  rerender({ taskId: 21, initialSelectedSkills: [] })
  expect(result.current.selectedSkills).toEqual([])

  rerender({ taskId: 21, initialSelectedSkills: [saved] })
  expect(result.current.selectedSkills).toEqual([saved])
})

it('keeps the current agent catalog when the previous agent lookup finishes last', async () => {
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([])
  let resolvePrevious!: (data: TeamSkillsResponse) => void
  const current = {
    team_id: 11,
    team_namespace: 'default',
    skills: ['current-skill'],
    preload_skills: [],
  }
  jest.mocked(fetchTeamSkills).mockImplementation(teamId =>
    teamId === current.team_id
      ? Promise.resolve(current)
      : new Promise(resolve => {
          resolvePrevious = resolve
        })
  )
  const { result, rerender } = renderHook(({ id }) => useSkillSelector({ team: { id } as Team }), {
    initialProps: { id: 10 },
  })
  rerender({ id: current.team_id })
  await waitFor(() => expect(result.current.teamSkillNames).toEqual(current.skills))

  await act(async () =>
    resolvePrevious({
      ...current,
      team_id: 10,
      skills: ['previous-skill'],
      preload_skills: ['previous-skill'],
    })
  )
  expect(result.current.teamSkillNames).toEqual(current.skills)
  expect(result.current.preloadedSkillNames).toEqual([])
})
