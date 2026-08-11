import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectAutomationRulesSection } from './ProjectAutomationRulesSection'

const rule = {
  id: 'rule-1',
  projectId: '1',
  name: '每日 Bug 扫描',
  prompt: '扫描回归 Bug',
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
  agentId: 'agent-1',
  agentName: '修复机器人',
  executionEnvironment: 'local' as const,
  executionDeviceId: 'device-1',
  enabled: true,
  nextRunAt: '2026-08-11T19:00:00Z',
  lastRunAt: null,
  lastRunStatus: null,
  version: 1,
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
}

const agent = {
  id: 'agent-1',
  projectId: '1',
  name: '修复机器人',
  runtime: 'codex' as const,
  model: null,
  systemPrompt: '',
  status: 'active' as const,
  visibility: 'public' as const,
  executionEnvironment: 'local' as const,
  executionMode: 'auto' as const,
  executionDeviceId: 'device-1',
  localProjectId: 1,
  createdByUserId: 1,
  version: 1,
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
}

describe('ProjectAutomationRulesSection', () => {
  it('creates a scheduled rule with the selected project robot', async () => {
    const api = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(rule),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)

    await waitFor(() => expect(agentApi.list).toHaveBeenCalledWith('1'))
    fireEvent.click(screen.getByTestId('project-automation-create'))
    fireEvent.change(screen.getByTestId('project-automation-name'), {
      target: { value: '每日 Bug 扫描' },
    })
    fireEvent.change(screen.getByTestId('project-automation-prompt'), {
      target: { value: '扫描回归 Bug' },
    })
    fireEvent.change(screen.getByTestId('project-automation-frequency'), {
      target: { value: 'weekdays' },
    })
    fireEvent.change(screen.getByTestId('project-automation-time'), {
      target: { value: '04:30' },
    })
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          name: '每日 Bug 扫描',
          prompt: '扫描回归 Bug',
          cronExpression: '30 4 * * 1-5',
          agentId: 'agent-1',
        })
      )
    )
  })

  it('shows a local run waiting for its device', async () => {
    const waitingRun = {
      id: 'run-1',
      automationId: rule.id,
      projectId: '1',
      trigger: 'scheduled' as const,
      status: 'waiting_device' as const,
      scheduledFor: '2026-08-11T19:00:00Z',
      expiresAt: '2026-08-12T19:00:00Z',
      taskId: null,
      deviceId: 'device-1',
      error: null,
      createdAt: '2026-08-11T19:00:00Z',
      updatedAt: '2026-08-11T19:00:00Z',
    }
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([waitingRun]),
      cancelRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)

    fireEvent.click(await screen.findByTestId('project-automation-rule-rule-1'))

    expect(await screen.findByTestId('project-automation-runs')).toHaveTextContent(
      'workbench.project_automation_waiting_device'
    )
  })
})
