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
  assignmentMode: 'manual' as const,
  managerType: null,
  webhookEventId: null,
  webhookSecret: null,
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
  agentId: 'agent-1',
  agentName: '修复机器人',
  wegentTeamId: null,
  model: null,
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
  it('opens a prefilled rule editor from an empty-state template', async () => {
    const api = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)

    fireEvent.click(await screen.findByTestId('project-automation-template-daily-progress'))

    const editor = screen.getByTestId('project-automation-editor')
    expect(editor.closest('section')?.parentElement?.parentElement).toBe(document.body)
    expect(editor).toHaveClass('grid', 'md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)]')
    expect(screen.getByTestId('project-automation-name')).toHaveValue(
      'workbench.project_automation_template_daily_progress_name'
    )
    expect(screen.getByTestId('project-automation-prompt')).toHaveValue(
      'workbench.project_automation_template_daily_progress_prompt'
    )
    expect(screen.getByTestId('project-automation-time')).toHaveValue('18:00')
    expect(screen.getByTestId('project-automation-frequency')).toHaveTextContent(
      'workbench.project_automation_weekdays'
    )
  })

  it('prefills the board management template as AI-managed custom dispatch', async () => {
    const api = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }
    const deviceApi = {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: 'local-device',
          name: 'Local executor',
          status: 'online' as const,
          is_default: true,
          device_type: 'local',
        },
      ]),
    }
    const modelApi = {
      listModels: vi.fn().mockResolvedValue({
        data: [{ name: 'model-1', displayName: 'Model 1', type: 'runtime' as const }],
      }),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        deviceApi={deviceApi}
        modelApi={modelApi}
        canManage
      />
    )

    await waitFor(() => expect(modelApi.listModels).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByTestId('project-automation-template-board-managed'))

    expect(screen.getByTestId('project-automation-name')).toHaveValue(
      'workbench.project_automation_template_board_managed_name'
    )
    expect(screen.getByTestId('project-automation-trigger-type')).toHaveTextContent(
      'workbench.project_automation_task_created_trigger'
    )
    expect(screen.getByTestId('project-automation-executor-type')).toHaveTextContent(
      'workbench.project_automation_ai_managed'
    )
    expect(screen.getByTestId('project-automation-manager-type')).toHaveTextContent(
      'workbench.project_automation_custom_ai'
    )
    expect((screen.getByTestId('project-automation-prompt') as HTMLTextAreaElement).value).toBe(
      'workbench.project_automation_default_managed_prompt'
    )
    expect(
      (screen.getByTestId('project-automation-prompt') as HTMLTextAreaElement).value
    ).not.toContain('wework-space')
    expect(screen.getByTestId('project-automation-model')).toHaveTextContent('Model 1')
    expect(screen.getByTestId('project-automation-device')).toHaveTextContent('Local executor')
    expect(screen.getByTestId('project-automation-save')).toBeEnabled()
  })

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
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        canManage
        projectTags={['triage']}
      />
    )

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
    fireEvent.click(screen.getByTestId('project-automation-condition-tags-triage'))
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          triggerType: 'event',
          eventType: 'task.created',
          eventConfig: { tags: ['triage'] },
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
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
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
          wegentTeamId: null,
          model: null,
          executionEnvironment: null,
          executionDeviceId: null,
        })
      )
    )
  })

  it('keeps existing rules available when the Wegent team catalog fails', async () => {
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }
    const teamApi = {
      listTeams: vi.fn().mockRejectedValue(new Error('Wegent team catalog unavailable')),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        teamApi={teamApi}
        canManage
      />
    )

    expect(await screen.findByTestId('project-automation-rule-rule-1')).toBeInTheDocument()
    expect(screen.getByText('Wegent team catalog unavailable')).toBeInTheDocument()
  })

  it('keeps custom manager settings across assignment switches and routes remote devices to cloud', async () => {
    const customRule = {
      ...rule,
      assignmentMode: 'ai_managed' as const,
      managerType: 'custom' as const,
      agentId: null,
      agentName: 'AI 托管',
      model: 'model-1',
      executionEnvironment: 'cloud' as const,
      executionDeviceId: 'remote-device',
    }
    const api = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(customRule),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }
    const deviceApi = {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: 'remote-device',
          name: 'Remote executor',
          status: 'online' as const,
          is_default: false,
          device_type: 'remote',
        },
      ]),
    }
    const modelApi = {
      listModels: vi.fn().mockResolvedValue({
        data: [
          { name: 'local-model', displayName: 'Local model', type: 'runtime' as const },
          { name: 'model-1', displayName: 'Model 1', type: 'public' as const },
        ],
      }),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        deviceApi={deviceApi}
        modelApi={modelApi}
        canManage
      />
    )

    await waitFor(() => expect(deviceApi.listDevices).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('project-automation-create'))
    fireEvent.change(screen.getByTestId('project-automation-name'), {
      target: { value: 'Remote custom AI' },
    })
    fireEvent.click(screen.getByTestId('project-automation-executor-type'))
    fireEvent.click(screen.getByTestId('project-automation-executor-type-option-ai_managed'))
    expect(screen.getByTestId('project-automation-prompt')).toHaveValue(
      'workbench.project_automation_default_managed_prompt'
    )
    fireEvent.click(screen.getByTestId('project-automation-model'))
    expect(
      screen.queryByTestId('project-automation-model-option-local-model')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-automation-model-option-model-1'))
    fireEvent.click(screen.getByTestId('project-automation-device'))
    fireEvent.click(screen.getByTestId('project-automation-device-option-remote-device'))

    fireEvent.click(screen.getByTestId('project-automation-executor-type'))
    fireEvent.click(screen.getByTestId('project-automation-executor-type-option-manual'))
    fireEvent.click(screen.getByTestId('project-automation-executor-type'))
    fireEvent.click(screen.getByTestId('project-automation-executor-type-option-ai_managed'))

    expect(screen.getByTestId('project-automation-model')).toHaveTextContent('Model 1')
    expect(screen.getByTestId('project-automation-device')).toHaveTextContent('Remote executor')
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          assignmentMode: 'ai_managed',
          managerType: 'custom',
          agentId: null,
          wegentTeamId: null,
          model: 'model-1',
          executionEnvironment: 'cloud',
          executionDeviceId: 'remote-device',
        })
      )
    )
  })

  it('stores the selected accessible Wegent manager by stable team ID', async () => {
    const wegentRule = {
      ...rule,
      assignmentMode: 'ai_managed' as const,
      managerType: 'wegent' as const,
      agentId: null,
      wegentTeamId: 42,
      agentName: 'Shared robot',
      executionEnvironment: 'managed' as const,
      executionDeviceId: null,
    }
    const api = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(wegentRule),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }
    const teamApi = {
      listTeams: vi.fn().mockResolvedValue([
        {
          id: 41,
          name: 'shared-robot',
          namespace: 'group-a',
          displayName: 'Same display name',
          is_active: true,
        },
        {
          id: 42,
          name: 'shared-robot',
          namespace: 'group-b',
          displayName: 'Same display name',
          is_active: true,
        },
        {
          id: 43,
          name: 'inactive-robot',
          namespace: 'default',
          displayName: 'Inactive robot',
          is_active: false,
        },
      ]),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        teamApi={teamApi}
        canManage
      />
    )

    await waitFor(() => expect(teamApi.listTeams).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('project-automation-create'))
    fireEvent.change(screen.getByTestId('project-automation-name'), {
      target: { value: 'Use shared robot' },
    })
    fireEvent.click(screen.getByTestId('project-automation-executor-type'))
    fireEvent.click(screen.getByTestId('project-automation-executor-type-option-ai_managed'))
    fireEvent.click(screen.getByTestId('project-automation-manager-type'))
    fireEvent.click(screen.getByTestId('project-automation-manager-type-option-wegent'))
    fireEvent.click(screen.getByTestId('project-automation-wegent-robot'))
    expect(
      screen.queryByTestId('project-automation-wegent-robot-option-43')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('project-automation-wegent-robot-option-42')).toHaveTextContent(
      'Same display name · group-b/shared-robot'
    )
    fireEvent.click(screen.getByTestId('project-automation-wegent-robot-option-42'))
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          assignmentMode: 'ai_managed',
          managerType: 'wegent',
          agentId: null,
          wegentTeamId: 42,
          model: null,
          executionEnvironment: null,
          executionDeviceId: null,
        })
      )
    )
  })

  it('removes legacy event conditions when an existing rule is saved', async () => {
    const legacyRule = {
      ...rule,
      id: 'legacy-event-rule',
      triggerType: 'event' as const,
      eventType: 'task.created' as const,
      eventConfig: {
        sources: ['local'],
        statuses: ['pending'],
        priorities: ['high'],
        tags: ['triage'],
      },
      webhookEventId: 'legacy-event-rule',
      cronExpression: null,
    }
    const api = {
      list: vi.fn().mockResolvedValue([legacyRule]),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({ ...legacyRule, version: 2 }),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(
      <ProjectAutomationRulesSection
        projectId="1"
        api={api}
        agentApi={agentApi}
        canManage
        projectTags={['triage']}
      />
    )

    fireEvent.click(await screen.findByTestId('project-automation-rule-legacy-event-rule'))
    expect(
      screen.queryByText('workbench.project_automation_condition_source')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('workbench.project_automation_condition_status')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('workbench.project_automation_condition_priority')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-automation-save'))

    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        '1',
        legacyRule.id,
        expect.objectContaining({
          eventConfig: { tags: ['triage'] },
          prompt: legacyRule.prompt,
          agentId: legacyRule.agentId,
          enabled: legacyRule.enabled,
        })
      )
    )
  })

  it('shows a local run as queued before it is claimed', async () => {
    const waitingRun = {
      id: 'run-1',
      automationId: rule.id,
      projectId: '1',
      trigger: 'scheduled' as const,
      status: 'queued' as const,
      timezone: 'Asia/Shanghai',
      scheduledFor: '2026-08-11T19:00:00Z',
      expiresAt: '2026-08-12T19:00:00Z',
      taskId: null,
      backendTaskId: null,
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
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([waitingRun]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)

    fireEvent.click(await screen.findByTestId('project-automation-rule-rule-1'))

    expect(await screen.findByTestId('project-automation-runs')).toHaveTextContent(
      'workbench.project_automation_queued'
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
      taskTitle: '回归失败任务',
      backendTaskId: null,
      deviceId: null,
      error: 'Robot is unavailable',
      retryable: true,
      createdAt: '2026-08-11T19:00:00Z',
      updatedAt: '2026-08-11T19:00:00Z',
    }
    const failedRuns = [
      finishedRun,
      ...Array.from({ length: 5 }, (_, index) => ({
        ...finishedRun,
        id: `run-older-${index + 1}`,
        taskTitle: `更早失败任务 ${index + 1}`,
      })),
    ]
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue(failedRuns),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)

    fireEvent.click(await screen.findByTestId('project-automation-rule-rule-1'))

    expect(await screen.findByTestId('project-automation-runs')).toBeInTheDocument()
    expect(screen.getByTestId('project-automation-run-task-run-2')).toHaveTextContent(
      '回归失败任务'
    )
    expect(screen.getByTestId('project-automation-run-task-run-older-5')).toHaveTextContent(
      '更早失败任务 5'
    )
    expect(screen.getByTestId('project-automation-run-list')).toHaveClass(
      'max-h-80',
      'overflow-y-auto',
      'overscroll-contain'
    )
    expect(screen.queryByText('Robot is unavailable')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-automation-run-detail-run-2'))
    expect(screen.getByTestId('project-automation-run-detail-dialog')).toHaveTextContent(
      'Robot is unavailable'
    )
    expect(screen.queryByTestId('project-automation-cancel-run-run-2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-automation-retry-run-run-older-5'))
    await waitFor(() => expect(api.retryRun).toHaveBeenCalledWith('1', 'run-older-5'))
  })

  it('keeps an active run synchronized until the backend reports its terminal state', async () => {
    const queuedRun = {
      id: 'run-live',
      automationId: rule.id,
      projectId: '1',
      trigger: 'manual' as const,
      status: 'queued' as const,
      timezone: 'Asia/Shanghai',
      scheduledFor: '2026-08-11T19:00:00Z',
      expiresAt: null,
      taskId: 'task-live',
      backendTaskId: null,
      deviceId: 'device-1',
      error: null,
      createdAt: '2026-08-11T19:00:00Z',
      updatedAt: '2026-08-11T19:00:00Z',
    }
    const completedRun = { ...queuedRun, status: 'succeeded' as const }
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValueOnce([queuedRun]).mockResolvedValue([completedRun]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)
    fireEvent.click(await screen.findByTestId('project-automation-rule-rule-1'))

    expect(await screen.findByTestId('project-automation-cancel-run-run-live')).toBeInTheDocument()
    await waitFor(
      () => expect(screen.queryByTestId('project-automation-cancel-run-run-live')).toBeNull(),
      { timeout: 2500 }
    )
    expect(api.listRuns).toHaveBeenCalledTimes(2)
  })

  it('shows an AI-managed triggered task without the removed decision contract', async () => {
    const managedRun = {
      id: 'run-managed',
      automationId: rule.id,
      projectId: '1',
      trigger: 'event' as const,
      status: 'running' as const,
      timezone: 'Asia/Shanghai',
      scheduledFor: '2026-08-11T19:00:00Z',
      expiresAt: null,
      taskId: 'task-1',
      backendTaskId: 12345,
      deviceId: null,
      error: null,
      createdAt: '2026-08-11T19:00:00Z',
      updatedAt: '2026-08-11T19:00:00Z',
    }
    const api = {
      list: vi.fn().mockResolvedValue([rule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([managedRun]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
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
    expect(
      screen.queryByTestId('project-automation-run-decision-run-managed')
    ).not.toBeInTheDocument()
  })

  it('rotates an event rule webhook secret and shows the replacement once', async () => {
    const eventRule = {
      ...rule,
      triggerType: 'event' as const,
      eventType: 'task.created' as const,
      webhookEventId: rule.id,
      webhookSecret: null,
      cronExpression: null,
      nextRunAt: null,
    }
    const rotated = { ...eventRule, webhookSecret: 'replacement-secret', version: 2 }
    const api = {
      list: vi.fn().mockResolvedValue([eventRule]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateWebhookSecret: vi.fn().mockResolvedValue(rotated),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const agentApi = {
      list: vi.fn().mockResolvedValue([agent]),
      create: vi.fn(),
      update: vi.fn(),
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ProjectAutomationRulesSection projectId="1" api={api} agentApi={agentApi} canManage />)
    fireEvent.click(await screen.findByTestId('project-automation-rule-rule-1'))
    expect(screen.getByTestId('project-automation-rules')).toHaveTextContent(
      'workbench.project_automation_waiting_event'
    )
    expect(screen.queryByTestId('project-automation-run-now')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('project-automation-rotate-webhook-secret'))

    await waitFor(() => expect(api.rotateWebhookSecret).toHaveBeenCalledWith('1', rule.id))
    expect((await screen.findAllByText('replacement-secret')).length).toBeGreaterThan(0)
  })
})
