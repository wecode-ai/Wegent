// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import SystemConfigPanel from '@/features/admin/components/SystemConfigPanel'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getSloganTipsConfig: jest.fn(),
    updateSloganTipsConfig: jest.fn(),
    getQuickAccessConfig: jest.fn(),
    updateQuickAccessConfig: jest.fn(),
    getPublicTeams: jest.fn(),
    getQuickLaunchFunctionsConfig: jest.fn(),
    updateQuickLaunchFunctionsConfig: jest.fn(),
  },
}))

const toastMock = jest.fn()

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const tMock = (key: string) => {
  const translations: Record<string, string> = {
    'admin:system_config.loading': 'Loading configuration...',
    'admin:system_config.title': 'System configuration',
    'admin:system_config.description': 'Manage system configuration',
    'admin:system_config.slogan_title': 'Slogans',
    'admin:system_config.add_slogan': 'Add slogan',
    'admin:system_config.no_slogans': 'No slogans',
    'admin:system_config.tips_title': 'Tips',
    'admin:system_config.add_tip': 'Add tip',
    'admin:system_config.no_tips': 'No tips',
    'admin:system_config.quick_access_title': 'Homepage recommended agents',
    'admin:system_config.quick_access_description':
      'Select the system agents shown on the homepage quick cards.',
    'admin:system_config.quick_access_available': 'Available agents',
    'admin:system_config.quick_access_selected': 'Homepage agents',
    'admin:system_config.quick_access_no_description': 'No description',
    'admin:system_config.quick_access_version': 'Homepage agents version',
    'admin:system_config.quick_launch_functions_title': 'System functions',
    'admin:system_config.quick_launch_functions_description':
      'Configure system function launchers as JSON.',
    'admin:system_config.quick_launch_functions_version': 'System functions version',
    'admin:system_config.version': 'Version',
    'admin:common.save': 'Save',
  }

  return translations[key] || key
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: tMock }),
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('SystemConfigPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getSloganTipsConfig.mockResolvedValue({
      version: 3,
      slogans: [],
      tips: [],
    })
    mockedAdminApis.getQuickAccessConfig.mockResolvedValue({
      version: 5,
      teams: [42],
    })
    mockedAdminApis.getPublicTeams.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 42,
          name: 'ai-assistant',
          namespace: 'default',
          display_name: 'AI Assistant',
          description: 'Built-in chat agent',
          json: { spec: { collaborationModel: 'pipeline', members: [] } },
          is_active: true,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    mockedAdminApis.getQuickLaunchFunctionsConfig.mockResolvedValue({
      version: 7,
      functions: [
        {
          id: 'create_ppt',
          title: 'Create PPT',
          description: 'Create presentation decks',
          icon: 'presentation',
          team_id: 42,
          enabled: true,
          order: 1,
          quick_phrases: ['Help me create a product roadmap PPT'],
        },
      ],
    })
    mockedAdminApis.updateSloganTipsConfig.mockResolvedValue({
      version: 4,
      slogans: [],
      tips: [],
    })
    mockedAdminApis.updateQuickLaunchFunctionsConfig.mockResolvedValue({
      version: 8,
      functions: [],
    })
  })

  test('loads and displays homepage quick access team configuration', async () => {
    render(<SystemConfigPanel />)

    expect(await screen.findByText('Homepage recommended agents')).toBeInTheDocument()
    expect(screen.getByText('AI Assistant')).toBeInTheDocument()
    expect(screen.getByText('Homepage agents version: 5')).toBeInTheDocument()
  })

  test('loads and saves system function launcher configuration', async () => {
    render(<SystemConfigPanel />)

    expect(await screen.findByTestId('quick-launch-functions-section')).toHaveTextContent(
      'System functions'
    )
    expect(screen.getByText('System functions version: 7')).toBeInTheDocument()

    const editor = screen.getByTestId('quick-launch-functions-json')
    expect((editor as HTMLTextAreaElement).value).toContain('Create PPT')

    fireEvent.change(editor, {
      target: {
        value: JSON.stringify(
          [
            {
              id: 'create_skill',
              title: 'Create Skill',
              team_id: 42,
              enabled: true,
              order: 1,
              quick_phrases: ['Help me create a skill'],
            },
          ],
          null,
          2
        ),
      },
    })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(mockedAdminApis.updateQuickLaunchFunctionsConfig).toHaveBeenCalledWith({
        functions: [
          {
            id: 'create_skill',
            title: 'Create Skill',
            team_id: 42,
            enabled: true,
            order: 1,
            quick_phrases: ['Help me create a skill'],
          },
        ],
      })
    })
  })
})
