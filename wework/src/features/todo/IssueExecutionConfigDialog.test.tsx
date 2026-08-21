import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
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

    const runtimeSelect = await screen.findByTestId('issue-execution-config-fields-runtime')
    expect(runtimeSelect).toHaveTextContent('我的本地')
    expect(runtimeSelect).not.toHaveTextContent('离线设备')

    await userEvent.selectOptions(runtimeSelect, 'runtime-online')
    await userEvent.selectOptions(screen.getByTestId('issue-execution-config-fields-project'), '7')
    await userEvent.click(screen.getByTestId('issue-execution-config-confirm'))

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        execution_config: {
          agent_id: 'agent-1',
          runtime_profile_id: 'runtime-online',
          model: 'kimi-code',
          workspace_binding: { type: 'backend_project', projectId: 7 },
        },
      })
    )
  })
})
