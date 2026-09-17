import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import type { Automation } from '@/types/automation'
import { emptyAutomationDraft, type AutomationDraft } from './automationDraft'
import { AutomationDetailWorkspace } from './AutomationDetailWorkspace'

function AutomationDetailHarness({
  devices = [],
  initialDraft = emptyAutomationDraft('local', 'local-device'),
  automation = null,
  runtimeWork = null,
  localDeviceIds = ['local-device'],
}: {
  devices?: React.ComponentProps<typeof AutomationDetailWorkspace>['devices']
  initialDraft?: AutomationDraft
  automation?: Automation | null
  runtimeWork?: RuntimeWorkListResponse | null
  localDeviceIds?: string[]
}) {
  const [draft, setDraft] = useState<AutomationDraft>(initialDraft)
  return (
    <AutomationDetailWorkspace
      draft={draft}
      automation={automation}
      runs={[]}
      locale="zh-CN"
      devices={devices}
      projects={[]}
      models={[]}
      currentRuntimeTask={null}
      runtimeWork={runtimeWork}
      localDeviceIds={localDeviceIds}
      cloudAvailable={devices.some(
        device => device.device_type === 'cloud' || device.device_type === 'remote'
      )}
      saving={false}
      dirty
      running={false}
      onChange={(key, value) => setDraft(current => ({ ...current, [key]: value }))}
      onModelChange={vi.fn()}
      onSourceChange={source => setDraft(current => ({ ...current, source }))}
      onClose={vi.fn()}
      onSave={vi.fn()}
      onRun={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
    />
  )
}

function device(
  deviceId: string,
  type: DeviceInfo['device_type'],
  overrides: Partial<DeviceInfo> = {}
): DeviceInfo {
  return {
    id: overrides.id ?? 1,
    device_id: deviceId,
    name: overrides.name ?? deviceId,
    status: 'online',
    is_default: false,
    device_type: type,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

const savedAutomation: Automation = {
  id: 'automation-1',
  version: 1,
  source: 'cloud',
  name: 'Remote automation',
  description: '',
  prompt: 'Run remotely',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },
  timezone: 'Asia/Shanghai',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

describe('AutomationDetailWorkspace', () => {
  test('enables the task instructions as a persistent goal', async () => {
    const user = userEvent.setup()
    render(<AutomationDetailHarness />)

    await user.click(screen.getByTestId('automation-goal-switch'))

    expect(screen.getByTestId('automation-goal-switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('将任务说明作为目标持续推进，直到目标完成')).toBeInTheDocument()
  })

  test('labels only the device matching the current executor identity as this computer', async () => {
    const user = userEvent.setup()
    render(
      <AutomationDetailHarness
        devices={[
          {
            id: 1,
            device_id: 'registered-current-device',
            app_device_id: 'local-device',
            name: '公司发的MicroLee用的MacbookPro',
            status: 'online',
            is_default: true,
            device_type: 'app',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
          },
          {
            id: 2,
            device_id: 'another-device',
            name: 'Local Executor',
            status: 'online',
            is_default: false,
            device_type: 'app',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
          },
        ]}
      />
    )

    await user.click(screen.getByTestId('automation-device-select'))

    expect(screen.getByTestId('automation-device-select-menu')).toHaveTextContent('此电脑')
    expect(screen.getByTestId('automation-device-select-menu')).toHaveTextContent('Local Executor')
  })

  test('shows Remote Docker under cloud and keeps unavailable devices visible but disabled', async () => {
    const user = userEvent.setup()
    render(
      <AutomationDetailHarness
        initialDraft={emptyAutomationDraft('cloud', 'remote-online')}
        devices={[
          device('local-device', 'app', { name: 'Local Executor' }),
          device('remote-online', 'remote', { name: 'Remote Alpha' }),
          device('remote-offline', 'remote', { name: 'Remote Offline', status: 'offline' }),
          device('remote-old', 'remote', {
            name: 'Remote Old',
            executor_version: '1.8.4',
          }),
          device('cloud-busy', 'cloud', { name: 'Cloud Busy', status: 'busy' }),
        ]}
      />
    )

    await user.click(screen.getByTestId('automation-device-select'))

    expect(screen.queryByTestId('automation-device-select-option-local-device')).toBeNull()
    expect(screen.getByTestId('automation-device-select-option-remote-online')).toBeEnabled()
    expect(screen.getByTestId('automation-device-select-option-remote-online')).toHaveTextContent(
      'Remote Alpha · 远程 Docker 设备'
    )
    expect(screen.getByTestId('automation-device-select-option-remote-offline')).toBeDisabled()
    expect(screen.getByTestId('automation-device-select-option-remote-offline')).toHaveTextContent(
      '离线'
    )
    expect(screen.getByTestId('automation-device-select-option-remote-old')).toBeDisabled()
    expect(screen.getByTestId('automation-device-select-option-remote-old')).toHaveTextContent(
      '需升级到 v1.8.5'
    )
    expect(screen.getByTestId('automation-device-select-option-cloud-busy')).toBeEnabled()
  })

  test('offers pinned tasks from available Remote Docker devices', async () => {
    const user = userEvent.setup()
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'remote-device',
          available: true,
          workspacePath: '/workspace',
          tasks: [
            {
              taskId: 'remote-task',
              title: 'Pinned remote task',
              runtime: 'codex',
              pinned: true,
              continuable: true,
            },
          ],
        },
        {
          deviceId: 'offline-device',
          available: false,
          workspacePath: '/offline',
          tasks: [
            {
              taskId: 'offline-task',
              title: 'Pinned offline task',
              runtime: 'codex',
              pinned: true,
              continuable: true,
            },
          ],
        },
      ],
      totalTasks: 2,
    }
    render(
      <AutomationDetailHarness
        devices={[
          device('remote-device', 'remote', { name: 'Remote Alpha' }),
          device('offline-device', 'remote', { name: 'Remote Offline', status: 'offline' }),
        ]}
        runtimeWork={runtimeWork}
      />
    )

    await user.click(screen.getByTestId('automation-conversation-mode'))
    await user.click(screen.getByTestId('automation-conversation-mode-option-continue_thread'))
    await user.click(screen.getByTestId('automation-target-task-select'))

    expect(
      screen.getByTestId('automation-target-task-select-option-remote-device:remote-task')
    ).toBeEnabled()
    expect(
      screen.getByTestId('automation-target-task-select-option-remote-device:remote-task')
    ).toHaveTextContent('Pinned remote task · Remote Alpha · 远程 Docker 设备')
    expect(
      screen.getByTestId('automation-target-task-select-option-offline-device:offline-task')
    ).toBeDisabled()
    expect(
      screen.getByTestId('automation-target-task-select-option-offline-device:offline-task')
    ).toHaveTextContent('离线')
  })

  test('keeps a saved automation target editable within its source', async () => {
    const user = userEvent.setup()
    render(
      <AutomationDetailHarness
        automation={savedAutomation}
        initialDraft={{
          ...emptyAutomationDraft('cloud', 'remote-device'),
          name: savedAutomation.name,
          prompt: savedAutomation.prompt,
        }}
        devices={[device('remote-device', 'remote', { name: 'Remote Alpha' })]}
      />
    )

    expect(screen.getByTestId('automation-conversation-mode')).toBeEnabled()
    expect(screen.getByTestId('automation-source-select')).toBeDisabled()
    expect(screen.getByTestId('automation-device-select')).toBeEnabled()

    await user.click(screen.getByTestId('automation-conversation-mode'))
    await user.click(screen.getByTestId('automation-conversation-mode-option-continue_thread'))

    expect(screen.getByTestId('automation-target-task-select')).toBeEnabled()
  })
})
