// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SkillSelectorPopover from '@/features/tasks/components/selector/SkillSelectorPopover'
import type { UnifiedSkill } from '@/apis/skills'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function buildSkill(overrides: Partial<UnifiedSkill>): UnifiedSkill {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'skill',
    namespace: overrides.namespace ?? 'default',
    description: overrides.description ?? 'Skill description',
    displayName: overrides.displayName,
    version: overrides.version,
    author: overrides.author,
    tags: overrides.tags,
    bindShells: overrides.bindShells,
    visible: overrides.visible,
    is_active: overrides.is_active ?? true,
    is_public: overrides.is_public ?? false,
    user_id: overrides.user_id ?? 1,
    availability: overrides.availability,
    source: overrides.source,
    created_at: overrides.created_at,
    updated_at: overrides.updated_at,
  }
}

describe('SkillSelectorPopover availability sections', () => {
  it('renders auto-available skills as read-only and selects only temporary skills', async () => {
    const user = userEvent.setup()
    const onToggleSkill = jest.fn()

    render(
      <SkillSelectorPopover
        skills={[
          buildSkill({
            id: 1,
            name: 'agent-skill',
            displayName: 'Agent Skill',
          }),
          buildSkill({
            id: 2,
            name: 'default-skill',
            displayName: 'Default Skill',
            availability: { inMyDefault: true },
          }),
          buildSkill({
            id: 3,
            name: 'temporary-skill',
            displayName: 'Temporary Skill',
          }),
        ]}
        teamSkillNames={['agent-skill']}
        preloadedSkillNames={[]}
        selectedSkillNames={[]}
        onToggleSkill={onToggleSkill}
        isChatShell={false}
      />
    )

    await user.click(screen.getByTitle('common:skillSelector.skill_button_tooltip'))

    expect(screen.getByText('common:skillSelector.autoAvailable')).toBeInTheDocument()
    expect(screen.getAllByText('common:skillSelector.temporaryUse')).toHaveLength(2)
    expect(screen.getByText('Agent Skill')).toBeInTheDocument()
    expect(screen.getByText('Default Skill')).toBeInTheDocument()
    expect(screen.getByText('Temporary Skill')).toBeInTheDocument()

    await user.click(screen.getByText('Agent Skill'))
    await user.click(screen.getByText('Default Skill'))
    expect(onToggleSkill).not.toHaveBeenCalled()

    await user.click(screen.getByText('Temporary Skill'))
    expect(onToggleSkill).toHaveBeenCalledWith('temporary-skill')
  })
})
