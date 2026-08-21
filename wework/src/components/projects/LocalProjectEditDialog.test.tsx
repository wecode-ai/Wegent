import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { LocalProjectEditDialog } from './LocalProjectEditDialog'

const pickerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPickers: pickerMocks.open,
}))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

const projectWork = {
  project: {
    key: 'multi-root',
    name: 'Product',
    source: 'local_project',
    stateDeviceId: 'local-device',
    roots: [
      { kind: 'local', path: '/repo/web' },
      { kind: 'local', path: '/repo/api' },
    ],
  },
  deviceWorkspaces: [],
}

const folderPickerProps = {
  device: { device_id: 'local-device', name: 'Local' },
  onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/repo'),
  onListDeviceDirectories: vi.fn().mockResolvedValue([]),
  onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
}

describe('LocalProjectEditDialog', () => {
  test('hides the default project space while experimental features are disabled', () => {
    experimentalFeatures.enabled = false
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        projectSpaceApis={[{} as ProjectSpaceApi]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.queryByTestId('local-project-auto-join-space-select')).not.toBeInTheDocument()
    experimentalFeatures.enabled = true
  })

  test('edits the name, primary folder, and source folder list', async () => {
    pickerMocks.open.mockResolvedValue(['/repo/docs'])
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    const nameInput = screen.getByTestId('local-project-name-input')
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Platform')
    await userEvent.click(screen.getByTestId('make-primary-root-1'))
    expect(screen.getByTestId('local-project-root-0')).toHaveTextContent('api')

    await userEvent.click(screen.getByTestId('add-local-project-folders'))
    expect(await screen.findByText('docs')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('remove-local-project-root-1'))
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'multi-root',
      name: 'Platform',
      roots: ['/repo/api', '/repo/docs'],
      defaultProjectSpace: null,
      aiSettings: {
        instructions: '',
        modelSelection: null,
      },
    })
  })

  test('keeps the final source folder and exposes delete project', async () => {
    const onDelete = vi.fn()
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, roots: [{ kind: 'local', path: '/repo/web' }] },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />
    )

    expect(screen.getByTestId('remove-local-project-root-0')).toBeDisabled()
    await userEvent.click(screen.getByTestId('delete-local-project-button'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  test('configures whether new conversations automatically join a project space', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const projectSpaceApi = {
      listCloudProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'space-1',
            public_id: 'space-public-1',
            project_key: 'FOLLOWUP',
            name: 'Task Follow-up Board',
            description: '',
            project_store: 'local',
            task_provider: 'local',
            provider_config: {},
            created_by_user_id: 1,
            status: 'active',
            tags: [],
            version: 1,
            created_at: '2026-08-04T00:00:00Z',
            updated_at: '2026-08-04T00:00:00Z',
          },
        ],
      }),
    } as unknown as ProjectSpaceApi

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            defaultProjectSpace: { projectStore: 'local', projectId: 'space-1' },
          },
        }}
        projectSpaceApis={[projectSpaceApi]}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    const select = await screen.findByTestId('local-project-auto-join-space-select')
    await waitFor(() => expect(select).toHaveValue('local:space-1'))
    await userEvent.selectOptions(select, '')
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'multi-root',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
      defaultProjectSpace: null,
      aiSettings: {
        instructions: '',
        modelSelection: null,
      },
    })
  })

  test('saves project instructions and a project-level default model', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        models={[
          {
            name: 'gpt-5.5',
            displayName: 'GPT-5.5',
            type: 'runtime',
            provider: 'local',
            config: {
              ui: {
                family: 'codex-provider',
                reasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: 'high',
              },
            },
          },
        ]}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('local-project-settings-ai-tab'))
    await userEvent.type(
      screen.getByTestId('local-project-instructions-input'),
      'Always run focused tests.'
    )
    await userEvent.selectOptions(
      screen.getByTestId('local-project-model-select'),
      'runtime:gpt-5.5'
    )
    await userEvent.selectOptions(screen.getByTestId('local-project-reasoning-select'), 'medium')
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'multi-root',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
      defaultProjectSpace: null,
      aiSettings: {
        instructions: 'Always run focused tests.',
        modelSelection: {
          modelName: 'gpt-5.5',
          modelType: 'runtime',
          options: expect.objectContaining({ reasoning: 'medium' }),
        },
      },
    })
  })

  test('installs a marketplace plugin for this project without leaving it globally enabled', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const installedPlugin = {
      metadata: { labels: { id: 'quality-gate@team-market' } },
      spec: { enabled: true },
    }
    const pluginApi = {
      readState: vi.fn().mockResolvedValue({
        marketplaceItems: [
          {
            id: 'team-market:quality-gate',
            name: 'quality-gate',
            displayName: 'Quality Gate',
            description: 'Checks changes before delivery',
            installed: false,
            sourceLabel: 'Team marketplace',
            manifest: { marketplaceId: 'team-market' },
          },
        ],
      }),
      installAvailablePlugin: vi.fn().mockResolvedValue(installedPlugin),
      updateInstalledPlugin: vi.fn().mockResolvedValue({
        ...installedPlugin,
        spec: { enabled: false },
      }),
    }

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        pluginApi={pluginApi as never}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    await userEvent.click(await screen.findByTestId('local-project-plugin-toggle-quality-gate'))
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(pluginApi.installAvailablePlugin).toHaveBeenCalledWith(
      'team-market:quality-gate',
      'team-market'
    )
    expect(pluginApi.updateInstalledPlugin).toHaveBeenCalledWith('quality-gate@team-market', {
      enabled: false,
    })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSettings: expect.objectContaining({
          plugins: [
            {
              id: 'quality-gate@team-market',
              pluginName: 'quality-gate',
              marketplaceId: 'team-market',
              displayName: 'Quality Gate',
            },
          ],
        }),
      })
    )
  })

  test('creates and persists a project quick phrase', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('local-project-settings-quick-phrases-tab'))
    await userEvent.click(screen.getByTestId('local-project-add-quick-phrase-button'))
    await userEvent.type(
      screen.getByTestId('local-project-quick-phrase-title-input'),
      '检查项目约束'
    )
    await userEvent.type(
      screen.getByTestId('local-project-quick-phrase-content-input'),
      '先阅读项目约束并列出验证步骤'
    )
    await userEvent.click(screen.getByTestId('local-project-quick-phrase-mode-plan'))
    await userEvent.click(screen.getByTestId('local-project-quick-phrase-save-button'))
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSettings: expect.objectContaining({
          quickPhrases: [
            expect.objectContaining({
              title: '检查项目约束',
              content: '先阅读项目约束并列出验证步骤',
              mode: 'plan',
            }),
          ],
        }),
      })
    )
  })

  test('respects marketplace policy when installing a plugin for a project', async () => {
    const pluginApi = {
      readState: vi.fn().mockResolvedValue({
        marketplaceItems: [
          {
            id: 'team-market:quality-gate',
            name: 'quality-gate',
            displayName: 'Quality Gate',
            installed: false,
            manifest: {
              marketplaceId: 'team-market',
              availability: 'DISABLED_BY_ADMIN',
            },
          },
        ],
      }),
      installAvailablePlugin: vi.fn(),
      updateInstalledPlugin: vi.fn(),
    }

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        pluginApi={pluginApi as never}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    const installButton = await screen.findByTestId('local-project-plugin-toggle-quality-gate')

    expect(installButton).toBeDisabled()
    expect(installButton).toHaveTextContent('管理员已禁用')
    expect(pluginApi.installAvailablePlugin).not.toHaveBeenCalled()
  })
})
