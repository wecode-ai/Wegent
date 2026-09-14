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

  act(() => result.current.toggleSkill('ps-agent-recagent'))

  expect(result.current.selectedSkills).toEqual([
    { skill_id: 275472, name: 'ps-agent-recagent', namespace: 'default', is_public: false },
  ])
})
