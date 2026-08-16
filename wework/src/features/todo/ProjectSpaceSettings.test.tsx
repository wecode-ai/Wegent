import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectSpaceSettings } from './ProjectSpaceSettings'

const localExecutorMocks = vi.hoisted(() => ({
  getLocalExecutorStatus: vi.fn(),
}))
const clipboardMocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => localExecutorMocks)
vi.mock('@/lib/clipboard', () => clipboardMocks)

describe('ProjectSpaceSettings', () => {
  beforeEach(() => {
    localExecutorMocks.getLocalExecutorStatus.mockReset()
    clipboardMocks.copyTextToClipboard.mockReset()
    localExecutorMocks.getLocalExecutorStatus.mockResolvedValue({
      running: true,
      deviceId: 'current-device',
    })
    clipboardMocks.copyTextToClipboard.mockResolvedValue(undefined)
  })

  it('shows current and remote device capacity and updates the selected runtime', async () => {
    const listDevices = vi.fn().mockResolvedValue([
      {
        id: 1,
        device_id: 'remote-device',
        name: 'Cloud worker',
        status: 'online',
        is_default: false,
        device_type: 'remote',
        bind_shell: 'claudecode',
        slot_used: 1,
        slot_max: 3,
      },
      {
        id: 2,
        device_id: 'current-device',
        name: 'My Mac',
        status: 'online',
        is_default: true,
        device_type: 'app',
        bind_shell: 'claudecode',
        slot_used: 2,
        slot_max: 4,
      },
    ])
    const updateRuntimeSettings = vi.fn().mockResolvedValue({
      device_id: 'remote-device',
      max_concurrent_tasks: 5,
      active_tasks: 1,
      queued_tasks: 0,
    })
    const deviceApi = { listDevices, updateRuntimeSettings } as unknown as NonNullable<
      WorkbenchServices['deviceApi']
    >

    render(<ProjectSpaceSettings deviceApi={deviceApi} />)

    expect(await screen.findByTestId('project-settings-total-capacity')).toHaveTextContent('7')
    expect(screen.getByTestId('project-settings-device-current-device')).toHaveTextContent(
      '当前设备'
    )
    expect(screen.getByTestId('project-settings-device-remote-device')).toHaveTextContent(
      '其他设备'
    )

    await userEvent.selectOptions(
      screen.getByTestId('project-settings-device-limit-remote-device'),
      '5'
    )

    await waitFor(() => expect(updateRuntimeSettings).toHaveBeenCalledWith('remote-device', 5))
    expect(screen.getByTestId('project-settings-total-capacity')).toHaveTextContent('9')
  })

  it('shows and copies both public API examples', async () => {
    const deviceApi = {
      listDevices: vi.fn().mockResolvedValue([]),
    } as unknown as NonNullable<WorkbenchServices['deviceApi']>

    render(<ProjectSpaceSettings deviceApi={deviceApi} />)

    expect(await screen.findByTestId('project-space-api-wiki')).toHaveTextContent(
      'POST /api/v1/cloud-projects'
    )
    await userEvent.click(screen.getByTestId('project-settings-copy-create-task'))
    expect(clipboardMocks.copyTextToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/cloud-projects/<project-id>/loop-items')
    )
  })
})
