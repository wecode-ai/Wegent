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

vi.mock('@/desktop/localExecutor', () => localExecutorMocks)
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

    await waitFor(() =>
      expect(screen.getByTestId('project-settings-total-capacity')).toHaveTextContent('7')
    )
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

  it('manages automations and active runs across project spaces', async () => {
    const update = vi.fn().mockResolvedValue({})
    const cancelRun = vi.fn().mockResolvedValue({})
    const automationApi = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'rule-1',
          name: 'Nightly review',
          enabled: true,
          version: 2,
          lastRunStatus: 'running',
        },
      ]),
      listRuns: vi.fn().mockResolvedValue([{ id: 'run-1', status: 'running' }]),
      update,
      cancelRun,
    }
    const project = {
      id: 'project-1',
      name: 'Product board',
      location: 'cloud',
    }
    const projectServices = {
      cloud: { projectAutomationApi: automationApi },
    }

    render(
      <ProjectSpaceSettings
        projects={[project] as never}
        projectServices={projectServices as never}
      />
    )

    expect(await screen.findByText('Nightly review')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('project-settings-cancel-run-run-1'))
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('project-1', 'run-1'))
    await userEvent.click(screen.getByTestId('project-settings-toggle-automation-rule-1'))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('project-1', 'rule-1', {
        version: 2,
        enabled: false,
      })
    )
  })

  it('does not request automations for public catalog projects without reporter access', async () => {
    const list = vi.fn().mockRejectedValue(new Error('Insufficient permission'))
    render(
      <ProjectSpaceSettings
        projects={
          [
            {
              id: 'public-project',
              name: 'Public board',
              location: 'cloud',
              access_role: 'RestrictedAnalyst',
            },
          ] as never
        }
        projectServices={{ cloud: { projectAutomationApi: { list } } } as never}
      />
    )

    expect(await screen.findByText('暂无项目自动化')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
    expect(screen.queryByText('Insufficient permission')).not.toBeInTheDocument()
  })

  it('orders automations with the enable action first inside a bounded scroll area', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 'disabled', name: 'A disabled', enabled: false, version: 1 },
      { id: 'enabled', name: 'Z enabled', enabled: true, version: 1 },
    ])
    const automationApi = { list, listRuns: vi.fn().mockResolvedValue([]) }
    render(
      <ProjectSpaceSettings
        projects={
          [{ id: 'project-1', name: 'Board', location: 'cloud', access_role: 'Owner' }] as never
        }
        projectServices={{ cloud: { projectAutomationApi: automationApi } } as never}
      />
    )

    const scrollArea = await screen.findByTestId('project-settings-automation-scroll-area')
    expect(scrollArea).toHaveClass('max-h-80', 'overflow-y-auto')
    expect(
      screen.getAllByTestId(/project-settings-toggle-automation-/).map(node => node.dataset.testid)
    ).toEqual([
      'project-settings-toggle-automation-disabled',
      'project-settings-toggle-automation-enabled',
    ])
  })
})
