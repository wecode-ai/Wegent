// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import MobileModelSelector from '@/features/tasks/components/selector/MobileModelSelector'
import MobileTeamSelector from '@/features/tasks/components/selector/MobileTeamSelector'
import type { Team } from '@/types/api'

const longModelName = '官网:kimi-k2.5-preview-with-a-very-long-model-name'
const longTeamName = '一个名字特别特别长的Wegent智能助理用于验证截断'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerContent: () => null,
  DrawerTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: () => <button type="button">Switch</button>,
}))

jest.mock('@/components/ui/tag', () => ({
  Tag: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}))

jest.mock('@/features/settings/components/teams/TeamIconDisplay', () => ({
  TeamIconDisplay: ({ className }: { className?: string }) => (
    <span data-testid="team-icon" className={className} />
  ),
}))

jest.mock('@/features/tasks/components/selector/SystemTeamTag', () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) => (
    <span data-testid="system-team-tag" className={className} />
  ),
}))

jest.mock('@/features/tasks/components/selector/useTeamFavorites', () => ({
  useTeamFavorites: () => ({
    favoriteTeamIdSet: new Set<number>(),
    favoriteUpdatingTeamId: null,
    handleToggleFavorite: jest.fn(),
    quickAccessMetaLoaded: false,
    systemRecommendedTeamIdSet: new Set<number>(),
  }),
}))

jest.mock('@/features/tasks/hooks/useModelSelection', () => ({
  DEFAULT_MODEL_NAME: '__default__',
  useModelSelection: () => ({
    selectedModel: {
      id: 'long-model',
      name: longModelName,
      displayName: longModelName,
      type: 'user',
    },
    forceOverride: false,
    filteredModels: [],
    showDefaultOption: false,
    isLoading: false,
    isMixedTeam: false,
    isModelRequired: false,
    error: null,
    getDisplayText: () => longModelName,
    selectModelByKey: jest.fn(),
    setForceOverride: jest.fn(),
  }),
}))

const selectedTeam: Team = {
  id: 1,
  name: 'long-team',
  displayName: longTeamName,
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '',
  updated_at: '',
  agent_type: 'chat',
}

describe('mobile selector truncation', () => {
  it('constrains the mobile model selector text to the available trigger width', () => {
    render(
      <MobileModelSelector
        selectedModel={null}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={selectedTeam}
        disabled={false}
      />
    )

    const label = screen.getByText(longModelName)
    const trigger = label.closest('button')

    expect(trigger).toHaveClass('w-full')
    expect(label).toHaveClass('truncate')
    expect(label).toHaveClass('flex-1')
    expect(label).toHaveClass('min-w-0')
  })

  it('constrains the mobile agent selector text to the available trigger width', () => {
    render(
      <MobileTeamSelector
        selectedTeam={selectedTeam}
        teams={[selectedTeam]}
        onTeamSelect={jest.fn()}
        disabled={false}
      />
    )

    const label = screen.getByText(longTeamName)
    const trigger = label.closest('button')

    expect(trigger).toHaveClass('w-full')
    expect(label).toHaveClass('truncate')
    expect(label).toHaveClass('flex-1')
    expect(label).toHaveClass('min-w-0')
  })
})
