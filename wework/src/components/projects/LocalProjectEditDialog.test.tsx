import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { LocalProjectEditDialog } from './LocalProjectEditDialog'
import { ProjectPluginsUnsupportedError } from '@/api/projectDevicePlugins'

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
  device: { device_id: 'local-device', device_type: 'local', name: 'Local' },
  onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/repo'),
  onListDeviceDirectories: vi.fn().mockResolvedValue([]),
  onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
}

describe('LocalProjectEditDialog', () => {
  test('keeps a saved default space readable when unsupported and absent from the catalog', async () => {
    const api = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ProjectSpaceApi
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          name: 'Unknown',
        }}
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            defaultProjectSpace: { projectStore: 'backend', projectId: 'saved-space' },
          },
        }}
        projectSpaceApis={[api]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    await screen.findByText('不自动加入')
    expect(screen.getByTestId('local-project-auto-join-space-select')).toHaveValue(
      'backend:saved-space'
    )
    expect(screen.getByTestId('local-project-auto-join-space-select')).toBeDisabled()
    expect(screen.getByTestId('project-default-space-upgrade-hint')).toBeVisible()
  })
  test('keeps a saved model readable when unsupported and absent from the catalog', () => {
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          name: 'Unknown',
        }}
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            aiSettings: { modelSelection: { modelName: 'saved-model', modelType: 'public' } },
          },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('local-project-settings-ai-tab'))
    expect(screen.getByTestId('local-project-model-select')).toHaveValue('public:saved-model')
    expect(screen.getByTestId('local-project-model-select')).toBeDisabled()
  })

  test('plugin RPC support does not authorize writes to an unsupported AI object', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const pluginApi = {
      readState: vi.fn().mockResolvedValue({
        marketplaceItems: [
          {
            id: 'quality@team',
            name: 'quality',
            installed: true,
            manifest: { marketplaceId: 'team' },
          },
        ],
      }),
      installAvailablePlugin: vi.fn(),
    }
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          name: 'Partial',
          runtime_features: {
            schemaVersion: 4,
            projectEditing: { multiRoots: true, aiSettings: false, plugins: true },
          },
        }}
        projectWork={projectWork}
        pluginApi={pluginApi}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(await screen.findByTestId('local-project-plugin-toggle-quality')).toBeDisabled()
    expect(screen.getByTestId('project-plugins-upgrade-hint')).toBeVisible()
    fireEvent.click(screen.getByTestId('save-local-project-button'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('aiSettings')
    expect(pluginApi.installAvailablePlugin).not.toHaveBeenCalled()
  })
  test('unsupported legacy plugins remain readable without blocking a supported save', async () => {
    const plugins = [
      { id: 'quality@team', pluginName: 'quality', marketplaceId: 'team', displayName: 'Quality' },
    ]
    const onSave = vi.fn().mockResolvedValue(undefined)
    const pluginApi = {
      readState: vi.fn().mockRejectedValue(new ProjectPluginsUnsupportedError()),
      installAvailablePlugin: vi.fn(),
    }
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          executor_version: '2.0.21',
          name: 'Legacy',
        }}
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, aiSettings: { instructions: 'Preserved', plugins } },
        }}
        pluginApi={pluginApi}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(await screen.findByTestId('project-plugins-upgrade-hint')).toBeVisible()
    expect(screen.getByTestId('remove-project-selected-plugin-quality@team')).toBeDisabled()
    expect(screen.getByTestId('save-local-project-button')).toBeEnabled()
    expect(screen.queryByTestId('local-project-plugins-loading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('save-local-project-button'))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ aiSettings: expect.objectContaining({ plugins }) })
      )
    )
    expect(pluginApi.installAvailablePlugin).not.toHaveBeenCalled()
  })

  test('a genuine plugin load error remains visible while unrelated settings can save', async () => {
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        pluginApi={{
          readState: vi.fn().mockRejectedValue(new Error('Unauthorized plugin inventory')),
          installAvailablePlugin: vi.fn(),
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized plugin inventory')
    expect(screen.getByTestId('save-local-project-button')).toBeEnabled()
    expect(screen.queryByTestId('project-plugins-upgrade-hint')).not.toBeInTheDocument()
  })
  test('keeps verified 1.8.5 folders editable while preserving unsupported AI settings', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          executor_version: '1.8.5',
          name: 'Legacy',
        }}
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, aiSettings: { instructions: 'Preserved' } },
        }}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('add-local-project-folders')).toBeEnabled()
    fireEvent.click(screen.getByTestId('local-project-settings-ai-tab'))
    expect(screen.getByTestId('local-project-instructions-input')).toBeDisabled()
    expect(screen.getByTestId('project-ai-settings-upgrade-hint')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-project-settings-quick-phrases-tab'))
    expect(screen.getByTestId('project-quick-phrases-upgrade-hint')).toBeVisible()
    fireEvent.click(screen.getByTestId('save-local-project-button'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(
      expect.not.objectContaining({ aiSettings: expect.anything() })
    )
  })

  test('unknown remote versions allow name-only editing and retain saved plugin selections', async () => {
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        device={{
          device_id: 'local-device',
          device_type: 'remote',
          status: 'online',
          name: 'Unknown',
        }}
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            aiSettings: {
              plugins: [
                {
                  id: 'quality@team',
                  pluginName: 'quality',
                  marketplaceId: 'team',
                  displayName: 'Quality',
                },
              ],
            },
          },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('local-project-name-input')).toBeEnabled()
    expect(screen.getByTestId('add-local-project-folders')).toBeDisabled()
    expect(screen.getByTestId('project-folders-upgrade-hint')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(screen.getByTestId('project-selected-plugin-quality@team')).toHaveTextContent('Quality')
    expect(screen.getByTestId('project-plugins-upgrade-hint')).toBeVisible()
    expect(screen.getByTestId('remove-project-selected-plugin-quality@team')).toBeDisabled()
  })
  test('saves a cached remote descriptor through the owning device and project key', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={{
          device_id: 'remote-device',
          device_type: 'remote',
          status: 'online',
          name: 'Remote',
          executor_version: '1.8.6',
        }}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            key: 'sidebar-alias',
            source: 'remote_project',
            ownerDeviceId: 'remote-device',
            ownerProjectKey: 'real-key',
          },
        }}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('save-local-project-button'))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'remote-device', projectKey: 'real-key' })
    )
  })

  test('opens remote directory browsing without invoking the native picker', async () => {
    pickerMocks.open.mockClear()
    const getHome = vi.fn().mockResolvedValue('/srv')
    const listDirectories = vi.fn().mockResolvedValue([])
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={{
          device_id: 'remote-device',
          device_type: 'remote',
          status: 'online',
          name: 'Remote',
          executor_version: '1.8.6',
        }}
        onGetDeviceHomeDirectory={getHome}
        onListDeviceDirectories={listDirectories}
        open
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, ownerDeviceId: 'remote-device' },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('add-local-project-folders'))
    expect(pickerMocks.open).not.toHaveBeenCalled()
    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith('remote-device', '/repo/web'))
  })

  test('shows offline status instead of upgrade hints when discovery omits runtime metadata', async () => {
    const pluginApi = { readState: vi.fn(), installAvailablePlugin: vi.fn() }
    const projectSpaceApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ProjectSpaceApi
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={{
          device_id: 'remote-device',
          device_type: 'remote',
          status: 'offline',
          name: 'Remote',
          executor_version: null,
          runtime_features: null,
        }}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            ownerDeviceId: 'remote-device',
            defaultProjectSpace: { projectStore: 'backend', projectId: 'saved-space' },
            aiSettings: {
              instructions: 'Saved instructions',
              modelSelection: { modelName: 'saved-model', modelType: 'public' },
              quickPhrases: [
                {
                  id: 'saved',
                  title: 'Saved quick phrase',
                  content: 'Keep this saved',
                  mode: 'plan',
                },
              ],
              plugins: [
                {
                  id: 'quality@team',
                  pluginName: 'quality',
                  marketplaceId: 'team',
                  displayName: 'Quality',
                },
              ],
            },
          },
        }}
        projectSpaceApis={[projectSpaceApi]}
        pluginApi={pluginApi as never}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    await screen.findByText('不自动加入')
    expect(screen.getByTestId('local-project-name-input')).toHaveValue('Product')
    expect(screen.getByTitle('/repo/web')).toBeVisible()
    expect(screen.getByTestId('local-project-auto-join-space-select')).toHaveValue(
      'backend:saved-space'
    )
    expect(screen.getByTestId('project-device-offline')).toBeVisible()
    expect(screen.queryAllByTestId(/upgrade-hint$/)).toHaveLength(0)
    expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
    expect(screen.getByTestId('add-local-project-folders')).toBeDisabled()
    fireEvent.click(screen.getByTestId('local-project-settings-ai-tab'))
    expect(screen.getByTestId('local-project-instructions-input')).toHaveValue('Saved instructions')
    expect(screen.getByTestId('local-project-model-select')).toHaveValue('public:saved-model')
    expect(screen.queryAllByTestId(/upgrade-hint$/)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('local-project-settings-quick-phrases-tab'))
    expect(screen.getByText('Saved quick phrase')).toBeVisible()
    expect(screen.queryAllByTestId(/upgrade-hint$/)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(screen.getByTestId('project-selected-plugin-quality@team')).toHaveTextContent('Quality')
    expect(screen.queryAllByTestId(/upgrade-hint$/)).toHaveLength(0)
    expect(screen.getByTestId('remove-project-selected-plugin-quality@team')).toBeDisabled()
    expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
    expect(pluginApi.readState).not.toHaveBeenCalled()
  })

  test('keeps an offline project readable while disabling save and directory mutations', () => {
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={{
          device_id: 'remote-device',
          device_type: 'remote',
          status: 'offline',
          name: 'Remote',
          executor_version: '1.8.6',
        }}
        open
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, ownerDeviceId: 'remote-device' },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('local-project-name-input')).toHaveValue('Product')
    expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
    expect(screen.getByTestId('add-local-project-folders')).toBeDisabled()
  })

  test('shows configured plugins for a cached missing device without permitting installation', async () => {
    const pluginApi = { readState: vi.fn(), installAvailablePlugin: vi.fn() }
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={null}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            ownerDeviceId: 'missing-device',
            aiSettings: {
              plugins: [
                {
                  id: 'quality@team',
                  pluginName: 'quality',
                  marketplaceId: 'team',
                  displayName: 'Quality',
                },
              ],
            },
          },
          deviceWorkspaces: [
            { deviceId: 'missing-device', workspacePath: '/repo', available: false, tasks: [] },
          ],
        }}
        pluginApi={pluginApi as never}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
    await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(screen.getByTestId('project-selected-plugin-quality@team')).toHaveTextContent('Quality')
    expect(screen.getByTestId('remove-project-selected-plugin-quality@team')).toBeDisabled()
    expect(pluginApi.readState).not.toHaveBeenCalled()
  })

  test('waits for a legacy remote project owner key before enabling save', async () => {
    const onSave = vi.fn()
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        device={{
          device_id: 'remote-device',
          name: 'Remote',
          executor_version: '1.8.6',
          status: 'online',
          device_type: 'remote',
        }}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            key: 'native-uuid',
            sidebarStateKey: 'native-uuid',
            source: 'remote_project',
          },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              remoteHostId: 'remote-device',
              workspacePath: '/repo',
              available: false,
              tasks: [],
            },
          ],
        }}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('project-owner-unresolved')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('save-local-project-button'))
    expect(onSave).not.toHaveBeenCalled()
  })

  test('stops pending catalog display offline and refreshes on reconnect without applying stale results', async () => {
    let resolveOldRead: (state: unknown) => void = () => {}
    let resolveNewRead: (state: unknown) => void = () => {}
    const pluginApi = {
      readState: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveOldRead = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveNewRead = resolve
            })
        ),
      installAvailablePlugin: vi.fn(),
    }
    const props = {
      ...folderPickerProps,
      open: true,
      device: { device_id: 'remote', device_type: 'remote', status: 'online', name: 'Remote' },
      projectWork: {
        ...projectWork,
        project: {
          ...projectWork.project,
          ownerDeviceId: 'remote',
          aiSettings: {
            plugins: [
              {
                id: 'quality@team',
                pluginName: 'quality',
                marketplaceId: 'team',
                displayName: 'Quality',
              },
            ],
          },
        },
      },
      pluginApi: pluginApi as never,
      onClose: vi.fn(),
      onSave: vi.fn(),
      onDelete: vi.fn(),
    }
    const view = render(<LocalProjectEditDialog {...props} />)
    await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
    expect(screen.getByTestId('local-project-plugin-search')).toBeDisabled()
    expect(screen.getByTestId('local-project-plugins-loading')).toBeInTheDocument()
    view.rerender(
      <LocalProjectEditDialog {...props} device={{ ...props.device, status: 'offline' }} />
    )
    expect(screen.getByTestId('local-project-plugin-search')).toBeEnabled()
    expect(screen.queryByTestId('local-project-plugins-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-selected-plugin-quality@team')).toHaveTextContent('Quality')
    expect(screen.getByTestId('remove-project-selected-plugin-quality@team')).toBeDisabled()
    view.rerender(<LocalProjectEditDialog {...props} />)
    await waitFor(() => expect(pluginApi.readState).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('local-project-plugins-loading')).toBeInTheDocument()
    expect(pluginApi.readState).toHaveBeenLastCalledWith({
      mergeAllMarketplaces: true,
      refresh: true,
    })
    await act(async () => {
      resolveOldRead({
        marketplaceItems: [
          {
            id: 'old',
            name: 'stale',
            displayName: 'Stale catalog',
            manifest: { marketplaceId: 'team' },
          },
        ],
      })
    })
    expect(screen.queryByTestId('local-project-plugin-row-stale')).not.toBeInTheDocument()
    await act(async () => {
      resolveNewRead({
        marketplaceItems: [
          {
            id: 'fresh',
            name: 'fresh',
            displayName: 'Fresh catalog',
            manifest: { marketplaceId: 'team' },
          },
        ],
      })
    })
    expect(await screen.findByTestId('local-project-plugin-row-fresh')).toHaveTextContent(
      'Fresh catalog'
    )
    expect(screen.getByTestId('local-project-plugin-search')).toBeEnabled()
    expect(screen.queryByTestId('local-project-plugins-loading')).not.toBeInTheDocument()
  })

  test('retains an unsaved draft when a known owner mirror receives its live project key', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Save rejected'))
    const props = {
      ...folderPickerProps,
      device: { device_id: 'remote', device_type: 'remote', status: 'online', name: 'Remote' },
      open: true,
      projectWork: {
        ...projectWork,
        project: {
          ...projectWork.project,
          key: 'mirror',
          ownerDeviceId: 'remote',
          ownerProjectKey: 'real',
          sidebarStateKey: 'mirror',
        },
      },
      onSave,
      onClose: vi.fn(),
      onDelete: vi.fn(),
    }
    const view = render(<LocalProjectEditDialog {...props} />)
    await userEvent.clear(screen.getByTestId('local-project-name-input'))
    await userEvent.type(screen.getByTestId('local-project-name-input'), 'Unsaved draft')
    await userEvent.click(screen.getByTestId('save-local-project-button'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save rejected')
    view.rerender(
      <LocalProjectEditDialog
        {...props}
        projectWork={{
          ...props.projectWork,
          project: { ...props.projectWork.project, key: 'real' },
        }}
      />
    )
    expect(screen.getByTestId('local-project-name-input')).toHaveValue('Unsaved draft')
    expect(screen.getByRole('alert')).toHaveTextContent('Save rejected')
  })
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

  test('selects a plugin installed through the device project adapter', async () => {
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
      expect.objectContaining({
        id: 'team-market:quality-gate',
        name: 'quality-gate',
        manifest: { marketplaceId: 'team-market' },
      })
    )
    expect(pluginApi.updateInstalledPlugin).not.toHaveBeenCalled()
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
