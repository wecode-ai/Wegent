import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { preloadDefaultDshUiTestModules } from '@/test/setup'
import { DesktopSidebar } from './DesktopSidebar'

await preloadDefaultDshUiTestModules()

describe('project menus during runtime hydration', () => {
  test.each([false, true])(
    'keeps an open menu mounted when the local device and sidebar mirror arrive (pinned=%s)',
    async pinned => {
      localStorage.clear()
      await preloadDefaultDshUiTestModules()
      const cloudDevice: DeviceInfo = {
        id: 2,
        device_id: 'cloud-device',
        device_type: 'cloud',
        name: 'Cloud device',
        status: 'online',
        is_default: false,
        bind_shell: 'claudecode',
      }
      const runtimeWork: RuntimeWorkListResponse = {
        projects: [
          {
            project: {
              id: 7,
              key: '/cloud/project',
              name: 'Cloud edited project',
              stateDeviceId: cloudDevice.device_id,
              source: 'local_project',
              pinned,
            },
            deviceWorkspaces: [
              {
                deviceId: cloudDevice.device_id,
                workspacePath: '/cloud/project',
                available: true,
                tasks: [],
              },
            ],
            totalTasks: 0,
          },
        ],
        chats: [],
        totalTasks: 0,
      }
      const props = {
        user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
        projects: [],
        devices: [cloudDevice],
        runtimeWork,
        onNewChat: vi.fn(),
        onSelectProject: vi.fn(),
        onStartNewProjectChat: vi.fn(),
        onUpdateProjectName: vi.fn(),
        onRemoveProject: vi.fn(),
        onOpenSettings: vi.fn(),
        onLogout: vi.fn(),
      }
      const store = new RuntimeTaskLifecycleStore('project-menu-hydration')
      store.syncRuntimeWork(runtimeWork)
      const sidebar = (nextProps: typeof props) => (
        <RuntimeTaskLifecycleProvider store={store}>
          <DesktopSidebar {...nextProps} />
        </RuntimeTaskLifecycleProvider>
      )
      const view = render(sidebar(props))
      const trigger = screen.getByTestId('project-menu-7')
      fireEvent.click(trigger)
      const menu = screen.getByTestId('project-menu-7-menu')

      const localDevice: DeviceInfo = {
        ...cloudDevice,
        device_id: 'local-device',
        device_type: 'local',
      }
      view.rerender(sidebar({ ...props, devices: [localDevice, cloudDevice] }))

      expect(screen.getByTestId('project-menu-7')).toBe(trigger)
      expect(screen.getByTestId('project-menu-7-menu')).toBe(menu)

      view.rerender(
        sidebar({
          ...props,
          devices: [localDevice, cloudDevice],
          runtimeWork: {
            ...runtimeWork,
            projects: [
              {
                ...runtimeWork.projects[0],
                project: {
                  ...runtimeWork.projects[0].project,
                  source: 'remote_project',
                  stateDeviceId: localDevice.device_id,
                  sidebarStateKey: 'wegent-remote:cloud-device:%2Fcloud%2Fproject',
                },
              },
            ],
          },
        })
      )

      expect(screen.getByTestId('project-menu-7')).toBe(trigger)
      expect(screen.getByTestId('project-menu-7-menu')).toBe(menu)
      await act(async () => {
        fireEvent.click(screen.getByTestId('rename-project-7'))
      })
      expect(screen.getByTestId('rename-project-input')).toHaveValue('Cloud edited project')
    }
  )
})
