import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectAutomationRulesSection } from './ProjectAutomationRulesSection'

const rule = {
  id: 'rule-1',
  projectId: '1',
  name: '每日 Bug 扫描',
  prompt: '扫描回归 Bug',
  triggerType: 'schedule' as const,
  eventType: null,
  eventConfig: {},
  webhookEventId: null,
  webhookSecret: null,
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
  it('creates a board-task event rule', async () => {
    const eventRule = {
      ...rule,
      id: 'event-rule-1',
      triggerType: 'event' as const,
      eventType: 'task.created' as const,
      webhookEventId: 'event-rule-1',
      webhookSecret: 'one-time-secret',
      cronExpression: null,
    }
    const api = {
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([eventRule]),
      create: vi.fn().mockResolvedValue(eventRule),
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
      target: { value: '新任务分派' },
    })
    fireEvent.change(screen.getByTestId('project-automation-prompt'), {
      target: { value: '阅读任务并选择负责人' },
    })
    fireEvent.click(screen.getByTestId('project-automation-trigger-type'))
    fireEvent.click(screen.getByTestId('project-automation-trigger-type-option-event'))
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          triggerType: 'event',
          eventType: 'task.created',
          cronExpression: null,
          agentId: 'agent-1',
        })
      )
    )
    expect(await screen.findByTestId('project-automation-rule-event-rule-1')).toHaveTextContent(
      'one-time-secret'
    )
  })

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
    fireEvent.click(screen.getByTestId('project-automation-frequency'))
    fireEvent.click(screen.getByTestId('project-automation-frequency-option-weekdays'))
    fireEvent.change(screen.getByTestId('project-automation-time'), {
      target: { value: '04:37' },
    })
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          name: '每日 Bug 扫描',
          prompt: '扫描回归 Bug',
          cronExpression: '37 4 * * 1-5',
          timezone: 'Asia/Shanghai',
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
      timezone: 'Asia/Shanghai',
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
      'workbench.project_automation_running'
    )
    expect(screen.getByTestId('project-automation-cancel-run-run-1')).toBeInTheDocument()
    expect(screen.getByTestId('project-automation-rules')).toHaveTextContent('2026-08-12 03:00')
    expect(screen.getByTestId('project-automation-rules')).toHaveTextContent(
      'workbench.project_automation_timezone_shanghai'
    )
  })

  it('shows a finished run as completed and keeps its outcome text', async () => {
    const finishedRun = {
      id: 'run-2',
      automationId: rule.id,
      projectId: '1',
      trigger: 'scheduled' as const,
      status: 'failed' as const,
      timezone: 'Asia/Shanghai',
      scheduledFor: '2026-08-11T19:00:00Z',
      expiresAt: null,
      taskId: null,
      deviceId: null,
      error: 'Robot is unavailable',
      createdAt: '2026-08-11T19:00:00Z',
      updatedAt: '2026-08-11T19:00:00Z',
    }
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([finishedRun]),
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
      'workbench.project_automation_completed'
    )
    expect(screen.getByTestId('project-automation-run-error-run-2')).toHaveTextContent(
      'Robot is unavailable'
    )
    expect(screen.queryByTestId('project-automation-cancel-run-run-2')).not.toBeInTheDocument()
  })
})
