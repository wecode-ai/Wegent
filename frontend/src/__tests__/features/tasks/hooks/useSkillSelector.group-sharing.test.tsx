// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { fetchUnifiedSkillsList } from '@/apis/skills'
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
  const initialSelectedSkills: string[] = []
  const { result } = renderHook(() => useSkillSelector({ team: null, initialSelectedSkills }))
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

it('can deselect a unique skill restored from name-only task metadata', async () => {
  const skill = {
    id: 3,
    name: 'pdf',
    namespace: 'engineering',
    description: '',
    user_id: 1,
    is_public: false,
    is_active: true,
  }
  jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([skill])
  const initialSelectedSkills = ['pdf']
  const { result } = renderHook(() => useSkillSelector({ team: null, initialSelectedSkills }))
  await waitFor(() => expect(result.current.selectedSkills[0].skill_id).toBe(3))
  act(() => result.current.toggleSkill(skill))
  expect(result.current.selectedSkills).toEqual([])
})
