import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ConversationProjectEditor } from './ConversationProjectEditor'

const mocks = vi.hoisted(() => ({ pluginApi: vi.fn(), workbench: null as unknown }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))

describe('conversation project editor', () => {
  test.each([
    ['remote', 'relay'],
    ['cloud', 'runtime'],
  ])(
    'keeps an online %s project editable through its %s owner alias',
    async (deviceType, ownerAlias) => {
      const pluginApi = {
        readState: vi.fn().mockResolvedValue({ marketplaceItems: [] }),
        installAvailablePlugin: vi.fn(),
      }
      const save = vi.fn().mockResolvedValue(undefined)
      const listDirectories = vi.fn().mockResolvedValue([])
      const canonicalDevice = {
        device_id: 'executor',
        socket_device_id: 'relay',
        runtime_instance_id: 'runtime',
        device_type: deviceType,
        status: 'online',
        name: 'Owner',
        executor_version: '2.0.21',
      }
      const projectWork = {
        project: {
          id: 7,
          key: 'real',
          sidebarStateKey: 'mirror',
          ownerDeviceId: ownerAlias,
          ownerProjectKey: 'real',
          stateDeviceId: 'local-device',
          name: 'Device project',
          source: 'remote_project',
          roots: [{ kind: 'local', path: '/owner' }],
        },
        deviceWorkspaces: [
          {
            deviceId: 'executor',
            remoteHostId: 'relay',
            workspaceSource: 'remote',
            workspacePath: '/owner',
            available: true,
            tasks: [],
          },
        ],
      }
      mocks.pluginApi.mockReset().mockReturnValue(pluginApi)
      mocks.workbench = {
        state: { devices: [canonicalDevice] },
        services: { projectDevicePluginApi: mocks.pluginApi },
        projectChat: { models: [] },
        getDeviceHomeDirectory: vi.fn().mockResolvedValue('/owner'),
        listDeviceDirectories: listDirectories,
        createDeviceDirectory: vi.fn(),
        updateLocalRuntimeProject: save,
        removeProject: vi.fn(),
      }
      render(<ConversationProjectEditor projectWork={projectWork} onClose={vi.fn()} />)
      expect(screen.getByTestId('save-local-project-button')).toBeEnabled()
      expect(screen.queryByTestId('project-device-offline')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
      await waitFor(() =>
        expect(pluginApi.readState).toHaveBeenCalledWith({
          mergeAllMarketplaces: true,
          refresh: true,
        })
      )
      await userEvent.click(screen.getByTestId('local-project-settings-basic-tab'))
      await userEvent.click(screen.getByTestId('add-local-project-folders'))
      expect(screen.getByTestId('local-project-folder-picker')).toBeInTheDocument()
      await waitFor(() => expect(listDirectories).toHaveBeenCalledWith('executor', '/owner'))
      await userEvent.click(screen.getByTestId('save-local-project-button'))
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: ownerAlias, projectKey: 'real', roots: ['/owner'] })
        )
      )
      expect(mocks.pluginApi).toHaveBeenCalledWith(ownerAlias)
    }
  )

  test.each(['remote', 'cloud'])('opens full settings for an offline %s owner', deviceType => {
    mocks.pluginApi.mockClear()
    mocks.workbench = {
      state: {
        devices: [
          { device_id: 'owner', device_type: deviceType, status: 'offline', name: 'Owner' },
        ],
      },
      services: { projectDevicePluginApi: mocks.pluginApi },
      projectChat: { models: [] },
      getDeviceHomeDirectory: vi.fn(),
      listDeviceDirectories: vi.fn(),
      createDeviceDirectory: vi.fn(),
      updateLocalRuntimeProject: vi.fn(),
      removeProject: vi.fn(),
    }
    render(
      <ConversationProjectEditor
        projectWork={{
          project: {
            key: 'mirror',
            sidebarStateKey: 'mirror',
            ownerDeviceId: 'owner',
            ownerProjectKey: 'real',
            stateDeviceId: 'local',
            name: 'Project',
            source: 'remote_project',
            roots: [{ kind: 'local', path: '/owner' }],
          },
          deviceWorkspaces: [],
        }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('local-project-edit-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
    expect(mocks.pluginApi).toHaveBeenCalledWith('owner')
  })
})
