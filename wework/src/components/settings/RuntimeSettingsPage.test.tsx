import '@/i18n'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RuntimeSettingsPage } from './RuntimeSettingsPage'

describe('RuntimeSettingsPage', () => {
  it('creates personal Runtimes and configures project defaults in settings', async () => {
    const created = {
      id: 'runtime-1',
      name: 'My Runtime',
      executionEnvironment: 'local' as const,
      executionDeviceId: 'device-1',
      model: 'model-1',
      modelType: 'runtime' as const,
      modelOptions: {},
      workspacePolicy: 'project' as const,
      status: 'active' as const,
      version: 1,
      createdAt: '',
      updatedAt: '',
    }
    const runtimeProfileApi = {
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([created]),
      getProjectDefault: vi
        .fn()
        .mockResolvedValueOnce({ projectId: '11', userId: 1, runtimeProfileId: null })
        .mockResolvedValue({ projectId: '11', userId: 1, runtimeProfileId: 'runtime-1' }),
      create: vi.fn().mockResolvedValue(created),
      delete: vi.fn(),
      setProjectDefault: vi
        .fn()
        .mockResolvedValue({ projectId: '11', userId: 1, runtimeProfileId: 'runtime-1' }),
    }

    render(
      <RuntimeSettingsPage
        runtimeProfileApi={runtimeProfileApi as never}
        deliveryApi={
          {
            listCloudProjects: vi.fn().mockResolvedValue({
              items: [{ id: '11', name: 'Wework', task_provider: 'local' }],
            }),
          } as never
        }
        deviceApi={
          {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'This Mac',
                status: 'online',
                is_default: true,
                device_type: 'local',
              },
            ]),
          } as never
        }
        modelApi={
          {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'model-1', displayName: 'Model 1', type: 'runtime' }],
            }),
          } as never
        }
      />
    )

    await waitFor(() => expect(runtimeProfileApi.list).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('runtime-profile-create'))
    expect(screen.getByTestId('runtime-profile-create-dialog')).toHaveTextContent(
      '正在配置 Runtime，请不要切换页面'
    )
    fireEvent.change(screen.getByTestId('runtime-profile-name'), {
      target: { value: 'My Runtime' },
    })
    fireEvent.click(screen.getByTestId('runtime-profile-save'))

    await waitFor(() =>
      expect(runtimeProfileApi.create).toHaveBeenCalledWith({
        name: 'My Runtime',
        executionEnvironment: 'local',
        executionDeviceId: 'device-1',
        model: 'model-1',
        workspacePolicy: 'project',
      })
    )
    expect(await screen.findByTestId('runtime-profile-runtime-1')).toHaveTextContent('My Runtime')
    expect(runtimeProfileApi.setProjectDefault).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('runtime-project-default-11'))
    fireEvent.click(await screen.findByTestId('runtime-project-default-11-option-runtime-1'))
    await waitFor(() =>
      expect(runtimeProfileApi.setProjectDefault).toHaveBeenCalledWith('11', 'runtime-1')
    )
  })
})
