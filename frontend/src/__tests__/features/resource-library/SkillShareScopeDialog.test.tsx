// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { UnifiedSkill } from '@/apis/skills'
import { SkillShareScopeDialog } from '@/features/resource-library/components/SkillShareScopeDialog'
import type { Group } from '@/types/group'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getPublication: jest.fn(),
    getMarketplaceTags: jest.fn(),
    updatePublication: jest.fn(),
  },
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

const mockTranslate = (key: string, options?: { count?: number }) =>
  key === 'sources.selected_groups' ? `${options?.count || 0} selected` : key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
    i18n: { language: 'zh-CN' },
  }),
}))

const skill = {
  id: 92,
  name: 'private-skill',
  namespace: 'default',
  description: 'Private skill',
  is_active: true,
  is_public: false,
  user_id: 1,
} as UnifiedSkill

const groups = [
  { id: 1, name: 'team-a', display_name: 'Team A', my_role: 'Owner' },
  { id: 2, name: 'team-b', display_name: 'Team B', my_role: 'Developer' },
] as Group[]

describe('SkillShareScopeDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(resourceLibraryApi.getPublication as jest.Mock).mockResolvedValue({
      id: 92,
      status: 'archived',
      target_groups: ['team-a'],
      tags: [],
    })
    ;(resourceLibraryApi.getMarketplaceTags as jest.Mock).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'technical_development',
          name_zh: '技术开发',
          name_en: 'Technical Development',
          sort: 10,
          enabled: true,
        },
      ],
    })
    ;(resourceLibraryApi.updatePublication as jest.Mock).mockResolvedValue({})
  })

  it('loads and saves multiple team targets', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()

    render(<SkillShareScopeDialog skill={skill} groups={groups} open onOpenChange={onOpenChange} />)

    await waitFor(() => {
      expect(screen.getByTestId('capability-scope-group-team-a')).toBeChecked()
    })
    await user.click(screen.getByTestId('capability-scope-group-team-b'))
    await user.click(screen.getByTestId('skill-share-scope-save'))

    expect(resourceLibraryApi.updatePublication).toHaveBeenCalledWith(92, {
      status: 'archived',
      target_groups: ['team-a', 'team-b'],
      allow_personal_install: false,
      allow_group_install: true,
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not reset edited groups when the close callback identity changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <SkillShareScopeDialog skill={skill} groups={groups} open onOpenChange={() => undefined} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('capability-scope-group-team-a')).toBeChecked()
    })
    await user.click(screen.getByTestId('capability-scope-group-team-b'))

    rerender(
      <SkillShareScopeDialog
        skill={{ ...skill }}
        groups={groups}
        open
        onOpenChange={() => undefined}
      />
    )

    expect(screen.getByTestId('capability-scope-group-team-b')).toBeChecked()
    expect(resourceLibraryApi.getPublication).toHaveBeenCalledTimes(1)
  })

  it('loads and saves marketplace tags for a published skill', async () => {
    const user = userEvent.setup()
    ;(resourceLibraryApi.getPublication as jest.Mock).mockResolvedValueOnce({
      id: 92,
      status: 'published',
      target_groups: [],
      tags: ['technical_development'],
    })

    render(
      <SkillShareScopeDialog skill={skill} groups={groups} open onOpenChange={() => undefined} />
    )

    const tag = await screen.findByTestId('marketplace-tag-option-technical_development')
    expect(tag).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId('skill-share-scope-save'))

    expect(resourceLibraryApi.updatePublication).toHaveBeenCalledWith(92, {
      status: 'published',
      target_groups: [],
      allow_personal_install: true,
      allow_group_install: true,
      tags: ['technical_development'],
    })
  })
})
