// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import { uploadAttachment } from '@/apis/attachments'
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

jest.mock('@/apis/attachments', () => ({
  uploadAttachment: jest.fn(),
  formatFileSize: (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`,
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
    'system_config.quick_launch_function_presets': 'Input presets',
    'system_config.quick_launch_function_add_preset': 'Add preset',
    'system_config.quick_launch_function_preset_title': 'Preset title',
    'system_config.quick_launch_function_preset_title_placeholder': 'Enter preset title',
    'system_config.quick_launch_function_preset_prompt': 'Prompt',
    'system_config.quick_launch_function_preset_prompt_placeholder': 'Enter prompt',
    'system_config.quick_launch_function_preset_skills': 'Skills',
    'system_config.quick_launch_function_preset_skills_placeholder': 'skill-a, skill-b',
    'system_config.quick_launch_function_preset_deep_thinking': 'Deep thinking',
    'system_config.quick_launch_function_preset_clarification': 'Clarification',
    'system_config.quick_launch_function_preset_force_override': 'Force override',
    'system_config.quick_launch_function_disabled': 'Disabled',
    'system_config.quick_launch_function_preset_attachments': 'Attachments',
    'system_config.quick_launch_function_preset_upload_attachment': 'Upload attachment',
    'system_config.quick_launch_function_preset_no_attachments': 'No attachments',
    'system_config.quick_launch_function_add': 'Add system function',
    'system_config.quick_launch_function_empty': 'No system functions',
    'system_config.version': 'Version',
    'common.save': 'Save',
    'common.done': 'Done',
    'common:actions.save': 'Save',
    'common:actions.cancel': 'Cancel',
    'common:actions.delete': 'Delete',
    'system_config.errors.partial_save_failed': 'Some configuration changes failed to save',
    'system_config.errors.quick_launch_attachment_upload_failed': 'Upload failed',
  }

  return translations[normalizedKey] || normalizedKey
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: tMock }),
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>
const mockedUploadAttachment = uploadAttachment as jest.MockedFunction<typeof uploadAttachment>

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
          input_presets: [
            {
              id: 'roadmap',
              title: 'Roadmap deck',
              prompt: 'Help me create a product roadmap PPT',
              options: {
                enable_deep_thinking: true,
                enable_clarification: false,
                force_override: false,
                selected_skill_names: ['slides'],
              },
              source_attachment_ids: [300],
            },
          ],
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
    mockedUploadAttachment.mockResolvedValue({
      id: 777,
      filename: 'template.pdf',
      file_size: 2048,
      mime_type: 'application/pdf',
      status: 'ready',
      text_length: 120,
      error_message: null,
      error_code: null,
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

    fireEvent.click(screen.getByTestId('edit-quick-launch-function-0'))
    fireEvent.change(screen.getByTestId('quick-launch-function-title-0'), {
      target: { value: 'Create Skill' },
    })
    fireEvent.change(screen.getByTestId('quick-launch-function-preset-title-0-0'), {
      target: { value: 'Skill builder' },
    })
    fireEvent.change(screen.getByTestId('quick-launch-function-preset-prompt-0-0'), {
      target: { value: 'Help me create a skill' },
    })
    fireEvent.change(screen.getByTestId('quick-launch-function-preset-skills-0-0'), {
      target: { value: 'skill-author, tests, skill-author' },
    })
    fireEvent.click(screen.getByTestId('quick-launch-function-preset-clarification-0-0'))
    fireEvent.click(screen.getByTestId('quick-launch-function-preset-force-override-0-0'))
    fireEvent.change(screen.getByTestId('quick-launch-function-preset-attachment-input-0-0'), {
      target: { files: [new File(['template'], 'template.pdf', { type: 'application/pdf' })] },
    })

    await waitFor(() => {
      expect(mockedUploadAttachment).toHaveBeenCalled()
    })
    expect(await screen.findByText('template.pdf - 2.0 KB')).toBeInTheDocument()

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
            input_presets: [
              {
                id: 'roadmap',
                title: 'Skill builder',
                prompt: 'Help me create a skill',
                options: {
                  enable_deep_thinking: true,
                  enable_clarification: true,
                  force_override: true,
                  selected_skill_names: ['skill-author', 'tests'],
                },
                source_attachment_ids: [300, 777],
              },
            ],
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
          input_presets: [
            {
              id: 'skill',
              title: 'Create skill',
              prompt: 'Help me create a skill',
              options: { selected_skill_names: [] },
            },
          ],
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
