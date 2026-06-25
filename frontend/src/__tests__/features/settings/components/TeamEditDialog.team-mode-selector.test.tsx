// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import TeamEditDialog from '@/features/settings/components/TeamEditDialog'

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:team.model': 'Collaboration mode',
        'common:teams.create_title': 'Create agent',
        'common:teams.description': 'Agent settings',
        'settings:team.simple.advanced_toggle': 'Advanced mode',
        'settings:team.simple.advanced_toggle_description': 'Use full configuration.',
        'settings:team.simple.non_solo_notice': 'This agent uses advanced collaboration.',
        'team_model.solo': 'Solo',
        'team_model.pipeline': 'Pipeline',
        'team_model.coordinate': 'Coordinate',
        'team_model_desc.solo': 'Single bot handles everything.',
        'team_model_desc.pipeline': 'Bots execute sequentially.',
        'team_model_desc.coordinate': 'Leader coordinates parallel work.',
      })[key] || key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
}))

jest.mock('@/features/settings/components/team-modes', () => ({
  getSelectableTeamModes: () => ['solo', 'pipeline', 'coordinate'],
  getAllowedAgentsForTeamMode: (mode: string) => {
    if (mode === 'pipeline' || mode === 'coordinate') return ['ClaudeCode']
    return undefined
  },
  getFilteredBotsForMode: (bots: unknown[]) => bots,
  getActualShellType: (shellType: string) => shellType,
}))

jest.mock('@/apis/bots', () => ({
  botApis: {
    getBot: jest.fn(),
    createBot: jest.fn(),
    updateBot: jest.fn(),
  },
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn().mockResolvedValue({ data: [] }),
  },
}))

jest.mock('@/apis/shells', () => {
  const actual = jest.requireActual('@/apis/shells')
  return {
    ...actual,
    shellApis: {
      ...actual.shellApis,
      getUnifiedShells: jest.fn().mockResolvedValue({ data: [] }),
    },
  }
})

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn().mockResolvedValue({ data: [] }),
  fetchPublicSkillsList: jest.fn().mockResolvedValue({ data: [] }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    refreshTeams: jest.fn(),
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open === false ? null : <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  ),
}))

jest.mock('@/features/settings/components/teams/TeamIconPicker', () => ({
  TeamIconPicker: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamBasicInfoForm', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeEditor', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeChangeDialog', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/SimpleTeamEditForm', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/TeamEditDrawer', () => ({
  __esModule: true,
  default: () => null,
}))

function renderCreateDialog() {
  return render(
    <TeamEditDialog
      open
      onClose={jest.fn()}
      teams={[]}
      setTeams={jest.fn()}
      editingTeamId={null}
      initialTeam={null}
      bots={[]}
      setBots={jest.fn()}
      toast={jest.fn()}
    />
  )
}

function getSelectorPanel(container: HTMLElement): HTMLElement {
  const panel = container.querySelector('.overflow-hidden.transition-all.duration-200')
  expect(panel).not.toBeNull()
  return panel as HTMLElement
}

describe('TeamEditDialog team mode selector', () => {
  it('keeps the mode selector expanded after selecting a collaboration mode', async () => {
    const { container } = renderCreateDialog()

    fireEvent.click(screen.getByTestId('advanced-mode-switch'))
    fireEvent.click(screen.getByRole('button', { name: 'Solo' }))

    const selectorPanel = getSelectorPanel(container)
    expect(selectorPanel).toHaveClass('opacity-100')

    fireEvent.click(screen.getByTestId('select-mode-label-pipeline'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pipeline' })).toBeInTheDocument()
    })
    expect(selectorPanel).toHaveClass('opacity-100')
  })
})
