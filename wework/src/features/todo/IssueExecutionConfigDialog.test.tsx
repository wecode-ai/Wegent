import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { WORKBENCH_MODELS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import { IssueExecutionConfigDialog } from './IssueExecutionConfigDialog'

const item = {
  id: 'WEG-1',
  cloud_project_id: 11,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  assignee_agent_id: 'agent-1',
  assignee_team_id: null,
  title: 'Run automation',
  description: '',
  status: 'inbox' as const,
  priority: 'high' as const,
  due_at: null,
  tags: [],
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-08-21T00:00:00Z',
  updated_at: '2026-08-21T00:00:00Z',
  completed_at: null,
}

describe('IssueExecutionConfigDialog', () => {
  it('refreshes cloud models when the hybrid catalog finishes loading', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ name: 'local-model', type: 'runtime', displayName: 'Local Model' }],
      })
      .mockResolvedValue({
        data: [
          { name: 'local-model', type: 'runtime', displayName: 'Local Model' },
          { name: 'cloud-model', type: 'public', displayName: 'Cloud Model' },
        ],
      })

    render(
      <IssueExecutionConfigDialog
        item={item}
        projectChatAgentApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        runtimeProfileApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        modelApi={{ listModels } as never}
        deviceApi={{ listDevices: vi.fn().mockResolvedValue([]) } as never}
        localProjects={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const modelSelect = await screen.findByTestId('issue-execution-config-fields-model')
    expect(modelSelect).toHaveTextContent('Local Model')
    expect(modelSelect).not.toHaveTextContent('Cloud Model')

    act(() => window.dispatchEvent(new Event(WORKBENCH_MODELS_CHANGED_EVENT)))

    await waitFor(() => expect(modelSelect).toHaveTextContent('Cloud Model'))
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it('requires the AI manager runtime snapshot before confirming', async () => {
    render(
      <IssueExecutionConfigDialog
        item={
          {
            ...item,
            assignee_agent_id: null,
            workflow: {
              version: 1,
              definition_version: 1,
              stage_mode: 'none',
              advancement_policy: 'ai',
              ai_automation_rule_id: 'ai-manager',
              execution_config: {
                agent_id: null,
                runtime_profile_id: 'runtime-incomplete',
                execution_device_id: 'device-online',
                model: null,
                model_type: null,
                model_options: {},
                workspace_binding: { type: 'standalone' },
              },
              nodes: [],
            },
          } as never
        }
        projectChatAgentApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        runtimeProfileApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        modelApi={
          {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'kimi-code', type: 'public', displayName: 'Kimi Code' }],
            }),
          } as never
        }
        deviceApi={
          {
            listDevices: vi
              .fn()
              .mockResolvedValue([{ device_id: 'device-online', status: 'online' }]),
          } as never
        }
        localProjects={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('issue-execution-config-confirm')).toBeDisabled())
  })

  it('requires runtime choices for workflow robot stages without a robot rule', async () => {
    render(
      <IssueExecutionConfigDialog
        item={
          {
            ...item,
            assignee_agent_id: null,
            workflow: {
              version: 1,
              definition_version: 1,
              stage_mode: 'dag',
              advancement_policy: 'manual',
              execution_config: null,
              nodes: [
                {
                  id: 'develop',
                  name: '开发',
                  execution_mode: 'robot',
                  depends_on: [],
                  required: true,
                  workspace_policy: 'composer',
                  automation_rule_id: null,
                  status: 'ready',
                },
              ],
            },
          } as never
        }
        projectChatAgentApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        runtimeProfileApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        modelApi={
          {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'kimi-code', type: 'public', displayName: 'Kimi Code' }],
            }),
          } as never
        }
        deviceApi={
          {
            listDevices: vi
              .fn()
              .mockResolvedValue([{ device_id: 'device-online', status: 'online' }]),
          } as never
        }
        localProjects={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(await screen.findByTestId('issue-execution-config-default-device')).toBeInTheDocument()
    expect(screen.getByTestId('issue-execution-config-confirm')).toBeDisabled()
  })

  it('uses a configured custom robot without requiring a runtime profile', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <IssueExecutionConfigDialog
        item={item}
        projectChatAgentApi={
          {
            list: vi.fn().mockResolvedValue([
              {
                id: 'agent-1',
                name: '自定义机器人',
                status: 'active',
                model: 'custom-model',
                defaultRuntimeProfileId: null,
                executionDeviceId: 'device-online',
                localProjectId: null,
                workspaceBinding: {
                  type: 'device_project',
                  status: 'ready',
                  deviceId: 'device-online',
                  runtimeProjectKey: 'project-1',
                },
              },
            ]),
          } as never
        }
        runtimeProfileApi={
          {
            list: vi.fn().mockResolvedValue([]),
          } as never
        }
        modelApi={
          {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'kimi-code', type: 'public', displayName: 'Kimi Code' }],
            }),
          } as never
        }
        deviceApi={
          {
            listDevices: vi
              .fn()
              .mockResolvedValue([{ device_id: 'device-online', status: 'online' }]),
          } as never
        }
        localProjects={[]}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const confirm = await screen.findByTestId('issue-execution-config-confirm')
    await waitFor(() => expect(confirm).toBeEnabled())
    expect(screen.queryByTestId('issue-execution-config-no-runtime')).not.toBeInTheDocument()
    await userEvent.click(confirm)

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        execution_config: {
          agent_id: 'agent-1',
          runtime_profile_id: null,
          execution_device_id: 'device-online',
          model: 'custom-model',
          model_type: null,
          model_options: {},
          workspace_binding: {
            type: 'device_project',
            deviceId: 'device-online',
            runtimeProjectKey: 'project-1',
          },
        },
      })
    )
  })

  it('keeps the robot device visible while the live device list is catching up', async () => {
    render(
      <IssueExecutionConfigDialog
        item={item}
        projectChatAgentApi={
          {
            list: vi.fn().mockResolvedValue([
              {
                id: 'agent-1',
                name: '本地机器人',
                status: 'active',
                model: 'custom-model',
                defaultRuntimeProfileId: null,
                executionDeviceId: 'configured-local-device',
                localProjectId: null,
                workspaceBinding: { type: 'standalone', status: 'ready' },
              },
            ]),
          } as never
        }
        runtimeProfileApi={{ list: vi.fn().mockResolvedValue([]) } as never}
        modelApi={{ listModels: vi.fn().mockResolvedValue({ data: [] }) } as never}
        deviceApi={
          {
            listDevices: vi
              .fn()
              .mockResolvedValue([{ device_id: 'current-local-device', status: 'online' }]),
          } as never
        }
        localProjects={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('issue-execution-config-fields-device')).toHaveValue(
        'configured-local-device'
      )
    )
  })

  it('lists only runtime environments whose devices are online and submits inline', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <IssueExecutionConfigDialog
        item={item}
        projectChatAgentApi={
          {
            list: vi.fn().mockResolvedValue([
              {
                id: 'agent-1',
                name: '修复机器人',
                status: 'active',
                model: null,
              },
            ]),
          } as never
        }
        runtimeProfileApi={
          {
            list: vi.fn().mockResolvedValue([
              {
                id: 'runtime-online',
                name: '我的本地',
                executionDeviceId: 'device-online',
                model: 'kimi-code',
                status: 'active',
              },
              {
                id: 'runtime-offline',
                name: '离线设备',
                executionDeviceId: 'device-offline',
                model: 'offline-model',
                status: 'active',
              },
            ]),
          } as never
        }
        modelApi={
          {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'kimi-code', type: 'public', displayName: 'Kimi Code' }],
            }),
          } as never
        }
        deviceApi={
          {
            listDevices: vi.fn().mockResolvedValue([
              { device_id: 'device-online', status: 'online' },
              { device_id: 'device-offline', status: 'offline' },
            ]),
          } as never
        }
        localProjects={[{ id: 7, name: 'Wegent' } as never]}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const deviceSelect = await screen.findByTestId('issue-execution-config-fields-device')
    expect(deviceSelect).toHaveTextContent('device-online')
    expect(deviceSelect).not.toHaveTextContent('device-offline')

    await userEvent.selectOptions(screen.getByTestId('issue-execution-config-fields-agent'), '')
    await userEvent.selectOptions(deviceSelect, 'device-online')
    await userEvent.selectOptions(
      screen.getByTestId('issue-execution-config-fields-model'),
      'public:kimi-code'
    )
    await userEvent.selectOptions(screen.getByTestId('issue-execution-config-fields-project'), '7')
    await userEvent.click(screen.getByTestId('issue-execution-config-confirm'))

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        execution_config: {
          agent_id: null,
          runtime_profile_id: null,
          execution_device_id: 'device-online',
          model: 'kimi-code',
          model_type: 'public',
          model_options: { collaborationMode: 'default' },
          workspace_binding: { type: 'backend_project', projectId: 7 },
        },
      })
    )
  })
})
