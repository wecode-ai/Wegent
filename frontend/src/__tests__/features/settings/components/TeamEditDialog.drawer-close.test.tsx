// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import TeamEditDialog from '@/features/settings/components/TeamEditDialog'

const dialogContentProps: Array<{ preventOutsideClick?: boolean }> = []

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:teams.create_title': 'Create agent',
        'common:teams.description': 'Agent settings',
        'settings:team.simple.non_solo_notice': 'This agent uses advanced collaboration.',
        'team_model.solo': 'Solo',
      })[key] || key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
}))

jest.mock('@/features/settings/components/team-modes', () => ({
  getSelectableTeamModes: () => ['solo'],
  getAllowedAgentsForTeamMode: () => undefined,
  getFilteredBotsForMode: (bots: unknown[]) => bots,
  getActualShellType: (shellType: string) => shellType,
}))

jest.mock('@/apis/bots', () => ({
  botApis: {
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
    invalidateTeams: jest.fn(),
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open === false ? null : <div>{children}</div>,
  DialogContent: ({
    children,
    preventOutsideClick,
  }: {
    children: ReactNode
    preventOutsideClick?: boolean
  }) => {
    dialogContentProps.push({ preventOutsideClick })
    return <div>{children}</div>
  },
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
  default: ({ onCreateBot }: { onCreateBot: () => void }) => (
    <button type="button" onClick={onCreateBot}>
      Create bot
    </button>
  ),
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

describe('TeamEditDialog nested bot drawer dismissal', () => {
  beforeEach(() => {
    dialogContentProps.length = 0
  })

  it('keeps new agent creation on the simplified path', () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        initialTeam={null}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    expect(dialogContentProps.at(-1)?.preventOutsideClick).toBeFalsy()

    expect(screen.queryByTestId('advanced-mode-switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create bot' })).not.toBeInTheDocument()
  })
})
