import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ConversationProjectEditor } from './ConversationProjectEditor'

const mocks = vi.hoisted(() => ({ pluginApi: vi.fn(), workbench: null as unknown }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))

describe('conversation project editor', () => {
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
