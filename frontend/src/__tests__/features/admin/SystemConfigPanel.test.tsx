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
  const normalizedKey = key.replace(/^admin:/, '')
  const translations: Record<string, string> = {
    'system_config.loading': 'Loading configuration...',
    'system_config.title': 'System configuration',
    'system_config.description': 'Manage system configuration',
    'system_config.slogan_title': 'Slogans',
    'system_config.add_slogan': 'Add slogan',
    'system_config.no_slogans': 'No slogans',
    'system_config.tips_title': 'Tips',
    'system_config.add_tip': 'Add tip',
    'system_config.no_tips': 'No tips',
    'system_config.quick_launch_functions_title': 'System functions',
    'system_config.quick_launch_functions_description':
      'Configure QuickCard system functions with form fields.',
    'system_config.quick_launch_functions_version': 'System functions version',
    'system_config.quick_launch_function_title': 'Title',
    'system_config.quick_launch_function_description': 'Description',
    'system_config.quick_launch_function_phrase_placeholder': 'Enter quick phrase',
    'system_config.quick_launch_function_add_phrase': 'Add phrase',
    'system_config.quick_launch_function_add': 'Add system function',
    'system_config.quick_launch_function_empty': 'No system functions',
    'system_config.version': 'Version',
    'common.save': 'Save',
    'common:actions.save': 'Save',
    'common:actions.cancel': 'Cancel',
    'common:actions.delete': 'Delete',
    'system_config.errors.partial_save_failed': 'Some configuration changes failed to save',
  }

  return translations[normalizedKey] || normalizedKey
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
    mockedAdminApis.getQuickAccessConfig.mockResolvedValue({ version: 5, teams: [42] })
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

  test('does not render the legacy homepage recommended agents configuration', async () => {
    render(<SystemConfigPanel />)

    expect(await screen.findByTestId('quick-launch-functions-section')).toBeInTheDocument()
    expect(screen.queryByTestId('quick-access-config-section')).not.toBeInTheDocument()
    expect(mockedAdminApis.getQuickAccessConfig).not.toHaveBeenCalled()
  })

  test('loads and saves system function launcher form configuration', async () => {
    render(<SystemConfigPanel />)

    expect(await screen.findByTestId('quick-launch-functions-section')).toHaveTextContent(
      'System functions'
    )
    expect(screen.getByText('System functions version: 7')).toBeInTheDocument()

    expect(screen.queryByTestId('quick-launch-functions-json')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-launch-function-card-0')).toHaveTextContent('Create PPT')

    fireEvent.change(screen.getByTestId('quick-launch-function-title-0'), {
      target: { value: 'Create Skill' },
    })
    fireEvent.change(screen.getByTestId('quick-launch-function-phrase-0-0'), {
      target: { value: 'Help me create a skill' },
    })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(mockedAdminApis.updateQuickLaunchFunctionsConfig).toHaveBeenCalledWith({
        functions: [
          {
            id: 'create_ppt',
            title: 'Create Skill',
            description: 'Create presentation decks',
            icon: 'presentation',
            team_id: 42,
            enabled: true,
            order: 1,
            quick_phrases: ['Help me create a skill'],
          },
        ],
      })
    })
  })

  test('keeps successful sections when saving partially fails', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockedAdminApis.updateSloganTipsConfig.mockRejectedValueOnce(new Error('slogan save failed'))
    mockedAdminApis.updateQuickLaunchFunctionsConfig.mockResolvedValueOnce({
      version: 9,
      functions: [
        {
          id: 'create_skill',
          title: 'Create Skill',
          description: 'Create skills',
          icon: 'sparkles',
          team_id: 42,
          enabled: true,
          order: 2,
          quick_phrases: ['Help me create a skill'],
        },
      ],
    })

    render(<SystemConfigPanel />)

    expect(await screen.findByTestId('quick-launch-functions-section')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText('System functions version: 9')).toBeInTheDocument()
    })
    expect(screen.getByTestId('quick-launch-function-card-0')).toHaveTextContent('Create Skill')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Some configuration changes failed to save',
        variant: 'destructive',
      })
    )
    consoleErrorSpy.mockRestore()
  })
})
