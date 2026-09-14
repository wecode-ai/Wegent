// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UnifiedSkill } from '@/apis/skills'
import SkillAutocomplete from '@/features/tasks/components/chat/SkillAutocomplete'
import SkillSelectorPopover from '@/features/tasks/components/selector/SkillSelectorPopover'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const sharedSkill: UnifiedSkill = {
  id: 275472,
  name: 'ps-agent-recagent',
  namespace: 'default',
  description: 'Shared by another member',
  user_id: 4239,
  is_public: false,
  is_active: true,
  visible: true,
  is_group_shared: true,
  publication_status: 'archived',
  availability: { inMyDefault: false },
}

describe.each(['button', 'autocomplete'] as const)('%s skill selection', entry => {
  it('selects the clicked record when two namespaces contain the same name', async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    const groupSkill = { ...sharedSkill, id: 9, namespace: 'engineering' }
    const props = {
      skills: [sharedSkill, groupSkill],
      teamSkillNames: [],
      preloadedSkillNames: [],
      selectedSkillNames: [sharedSkill.name],
      selectedSkillIds: [groupSkill.id],
      isChatShell: false,
    }
    if (entry === 'button') {
      render(<SkillSelectorPopover {...props} onToggleSkill={onSelect} />)
      await user.click(screen.getByTitle('common:skillSelector.skill_button_tooltip'))
    } else {
      render(
        <SkillAutocomplete
          {...props}
          query=""
          position={{ top: 0, left: 0 }}
          onSelect={onSelect}
          onClose={jest.fn()}
        />
      )
    }
    const rows = screen.getAllByRole('button', { name: /ps-agent-recagent/ })
    expect(rows).toHaveLength(2)
    await user.click(rows[1])
    expect(onSelect).toHaveBeenCalledWith(groupSkill)
  })

  it('groups a shared personal skill with group skills and allows selection', async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    const props = {
      skills: [
        sharedSkill,
        { ...sharedSkill, id: 2, name: 'personal', is_group_shared: false },
        { ...sharedSkill, id: 3, name: 'group-owned', namespace: 'agentx' },
        { ...sharedSkill, id: 4, name: 'public', is_public: true, user_id: 0 },
      ],
      teamSkillNames: [],
      preloadedSkillNames: [],
      selectedSkillNames: [],
      isChatShell: false,
    }

    if (entry === 'button') {
      render(<SkillSelectorPopover {...props} onToggleSkill={onSelect} />)
      await user.click(screen.getByTitle('common:skillSelector.skill_button_tooltip'))
    } else {
      render(
        <SkillAutocomplete
          {...props}
          query=""
          position={{ top: 0, left: 0 }}
          onSelect={onSelect}
          onClose={jest.fn()}
        />
      )
    }

    const sharedHeader = screen.getByText('common:skillSelector.group_skills_section')
    const sharedRow = screen.getByRole('button', { name: /ps-agent-recagent/ })
    expect(sharedHeader.nextElementSibling).toBe(sharedRow)
    expect(screen.queryByText('common:skillSelector.group_skills_section - default')).toBeNull()
    expect(screen.getByText('common:skillSelector.group_skills_section - agentx')).toBeVisible()
    expect(screen.getByText('common:skillSelector.personal_skills_section')).toBeVisible()
    expect(screen.getByText('common:skillSelector.public_skills_section')).toBeVisible()

    await user.click(sharedRow)
    expect(onSelect).toHaveBeenCalledWith(sharedSkill)
    expect(sharedSkill.namespace).toBe('default')
  })
})
