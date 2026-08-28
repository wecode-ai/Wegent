// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { AdminPublicTeam } from '@/apis/admin'
import { publicResourceApis } from '@/apis/publicResources'
import PublicTeamEditDialog from '@/features/admin/components/PublicTeamEditDialog'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    deletePublicTeamIcon: jest.fn(),
    uploadPublicTeamIcon: jest.fn(),
  },
}))

jest.mock('@/apis/publicResources', () => ({
  publicResourceApis: {
    getPublicBots: jest.fn(),
    getPublicModels: jest.fn(),
    getPublicShells: jest.fn(),
  },
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ value, children }: { value: string; children: ReactNode }) =>
    value === 'basic' ? <div>{children}</div> : null,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

jest.mock('@/features/settings/components/team-edit/TeamBasicInfoForm', () => ({
  __esModule: true,
  default: () => <div data-testid="team-basic-info-form" />,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="team-mode-selector" />,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeEditor', () => ({
  __esModule: true,
  default: ({
    modelCategoryType,
    allowGenerationPrimaryModel,
  }: {
    modelCategoryType?: string
    allowGenerationPrimaryModel?: boolean
  }) => (
    <div
      data-testid="team-mode-editor"
      data-model-category={modelCategoryType}
      data-allow-generation-primary={String(allowGenerationPrimaryModel)}
    />
  ),
}))

jest.mock('@/features/settings/components/team-edit/TeamModeChangeDialog', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/TeamEditDrawer', () => ({
  __esModule: true,
  default: () => null,
}))

const testVideoTeam: AdminPublicTeam = {
  id: 1,
  name: 'test-video-team',
  namespace: 'default',
  display_name: 'Test Video Team',
  description: 'Test team configuration.',
  json: {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Team',
    metadata: {
      name: 'test-video-team',
      namespace: 'default',
      displayName: 'Test Video Team',
    },
    spec: {
      members: [
        {
          botRef: {
            name: 'test-video-bot',
            namespace: 'default',
          },
          role: 'leader',
        },
      ],
      collaborationModel: 'solo',
      bind_mode: ['chat'],
      modeSpec: {
        allowedModelCategories: ['video'],
        hiddenVideoParams: ['duration'],
      },
    },
  },
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const mockedPublicResourceApis = publicResourceApis as jest.Mocked<typeof publicResourceApis>

describe('PublicTeamEditDialog video model configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPublicResourceApis.getPublicBots.mockResolvedValue([])
    mockedPublicResourceApis.getPublicShells.mockResolvedValue([])
  })

  it('configures the video and planning models inside the Bot editor', async () => {
    render(
      <PublicTeamEditDialog
        open
        editingTeam={testVideoTeam}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
        toast={jest.fn()}
      />
    )

    const editor = await screen.findByTestId('team-mode-editor')
    expect(editor).toHaveAttribute('data-model-category', 'video')
    expect(editor).toHaveAttribute('data-allow-generation-primary', 'false')
    expect(screen.queryByTestId('public-team-video-model-config')).not.toBeInTheDocument()
    expect(mockedPublicResourceApis.getPublicModels).not.toHaveBeenCalled()
  })

  it('allows a new solo Chat agent to choose a video primary model on its Bot', async () => {
    render(
      <PublicTeamEditDialog
        open
        editingTeam={null}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
        toast={jest.fn()}
      />
    )

    expect(await screen.findByTestId('team-mode-editor')).toHaveAttribute(
      'data-allow-generation-primary',
      'true'
    )
  })
})
