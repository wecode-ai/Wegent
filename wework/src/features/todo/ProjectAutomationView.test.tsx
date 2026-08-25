import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectAutomationRule, ProjectAutomationRun } from '@/api/projectAutomations'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectAutomationView } from './ProjectAutomationView'

const project = {
  id: 11,
  name: 'Automation project',
  current_user_id: 7,
  tags: ['自动开发', '缺陷'],
} as CloudProject

const rule: ProjectAutomationRule = {
  id: 'rule-1',
  projectId: '11',
  name: '新 Issue 自动开发',
  prompt: '自动开发',
  triggerType: 'event',
  eventType: 'task.created',
  eventConfig: {
    tags: ['自动开发'],
    wework_flow: {
      version: 1,
      description: '创建需求后自动分析、实现并回写结果',
      steps: [
        {
          id: 'step-1',
          name: '分析需求',
          prompt: '理解需求',
          kind: 'task',
          deliverables: [],
          executionMode: 'automatic',
          environment: '本机 · Wegent',
          executionEnvironment: 'local',
          executionDeviceId: 'local-device',
          runtimeProfileId: 'profile-1',
          model: 'GPT-5.6 Codex',
          modelType: 'runtime',
          modelOptions: {},
          plugins: ['Wework 项目空间'],
          projectPlugins: [],
          workspacePolicy: 'composer',
          required: true,
          dagEnabled: false,
          dagStages: [],
        },
        {
          id: 'step-2',
          name: 'AI 动态分配',
          prompt: '动态拆解任务',
          kind: 'dynamic',
          deliverables: [],
          executionMode: 'automatic',
          environment: '本机 · Wegent',
          executionEnvironment: 'local',
          executionDeviceId: 'local-device',
          runtimeProfileId: 'profile-1',
          model: 'GPT-5.6 Codex',
          modelType: 'runtime',
          modelOptions: {},
          plugins: ['Wework 项目空间'],
          projectPlugins: [],
          workspacePolicy: 'composer',
          required: true,
          dagEnabled: true,
          dagStages: [
            {
              id: 'dag-stage-step-2-analysis',
              name: '分析需求',
              instruction: '分析',
              dependencies: [],
              x: 24,
              y: 105,
            },
            {
              id: 'dag-stage-step-2-delivery',
              name: '汇总交付',
              instruction: '汇总',
              dependencies: ['dag-stage-step-2-analysis'],
              x: 424,
              y: 105,
            },
          ],
        },
        {
          id: 'step-3',
          name: '回写 Issue',
          prompt: '回写结果',
          kind: 'task',
          deliverables: [],
          executionMode: 'automatic',
          environment: '本机 · Wegent',
          executionEnvironment: 'local',
          executionDeviceId: 'local-device',
          runtimeProfileId: 'profile-1',
          model: 'GPT-5.6 Codex',
          modelType: 'runtime',
          modelOptions: {},
          plugins: ['Wework 项目空间'],
          projectPlugins: [],
          workspacePolicy: 'inherit',
          required: true,
          dagEnabled: false,
          dagStages: [],
        },
      ],
    },
  },
  webhookEventId: 'event-1',
  webhookSecret: null,
  cronExpression: null,
  timezone: 'Asia/Shanghai',
  assignmentMode: 'manual',
  managerType: null,
  agentId: null,
  wegentTeamId: null,
  model: null,
  agentName: '自动化执行器',
  executionEnvironment: 'local',
  executionDeviceId: null,
  enabled: true,
  nextRunAt: null,
  lastRunAt: '2026-08-25T02:32:00Z',
  lastRunStatus: 'succeeded',
  version: 2,
  createdAt: '2026-08-24T02:32:00Z',
  updatedAt: '2026-08-25T02:32:00Z',
  roleSource: 'generic',
  runtimeSource: 'runtime_user',
  runtimeProfileId: null,
  runtimeUserId: 7,
}

const run: ProjectAutomationRun = {
  id: 'run-1',
  automationId: 'rule-1',
  projectId: '11',
  trigger: 'event',
  status: 'succeeded',
  timezone: 'Asia/Shanghai',
  scheduledFor: '2026-08-25T02:32:00Z',
  expiresAt: null,
  taskId: 'WEG-842',
  taskTitle: 'WEG-842 统一自动化概念',
  backendTaskId: null,
  deviceId: 'local-device',
  error: null,
  createdAt: '2026-08-25T02:32:00Z',
  updatedAt: '2026-08-25T02:38:18Z',
  completedAt: '2026-08-25T02:38:18Z',
}

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

function renderView({
  viewProject = project,
  listedRules = [rule],
  onProjectUpdated,
}: {
  viewProject?: CloudProject
  listedRules?: ProjectAutomationRule[]
  onProjectUpdated?: (project: CloudProject) => void
} = {}) {
  const projectAutomationApi = {
    list: vi.fn().mockResolvedValue(listedRules),
    listRuns: vi.fn().mockResolvedValue([run]),
    create: vi.fn(),
    migrateWorkflow: vi.fn().mockImplementation((_projectId, input) =>
      Promise.resolve({
        automation: {
          ...rule,
          id: 'rule-migrated',
          name: input.automation.name,
          prompt: input.automation.prompt,
          eventConfig: input.automation.eventConfig,
        },
        projectVersion: viewProject.version + 1,
        workflowAutomationId: 'rule-migrated',
      })
    ),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue({
      projectVersion: viewProject.version + 1,
      workflowAutomationId: null,
    }),
    runNow: vi.fn(),
  } as unknown as NonNullable<WorkbenchServices['projectAutomationApi']>
  const deviceApi = {
    listDevices: vi.fn().mockResolvedValue([
      {
        id: 1,
        device_id: 'local-device',
        name: '本机执行器',
        status: 'online',
        is_default: true,
        device_type: 'local',
      },
    ]),
  } as unknown as WorkbenchServices['deviceApi']
  const modelApi = {
    listModels: vi.fn().mockResolvedValue({
      data: [
        {
          name: 'codex-runtime',
          displayName: 'Codex Runtime',
          type: 'runtime',
          isActive: true,
        },
      ],
    }),
  } as unknown as WorkbenchServices['modelApi']
  const pluginApi = {
    listPlugins: vi.fn().mockResolvedValue([
      {
        id: 'plugin-1',
        pluginName: 'wework-space',
        marketplaceId: 'market-1',
        displayName: 'Wework 项目空间',
      },
    ]),
  }
  render(
    <ProjectAutomationView
      api={{} as NonNullable<WorkbenchServices['deliveryApi']>}
      project={viewProject}
      projectAutomationApi={projectAutomationApi}
      deviceApi={deviceApi}
      modelApi={modelApi}
      pluginApi={pluginApi}
      currentUserId={7}
      canManageAgents
      onProjectUpdated={onProjectUpdated}
    />
  )
  return { projectAutomationApi, deviceApi, modelApi, pluginApi }
}

describe('ProjectAutomationView', () => {
  test('renders backend automations directly inside the project shell', async () => {
    const { projectAutomationApi, deviceApi, modelApi, pluginApi } = renderView()

    expect(await screen.findByTestId('automation-card-rule-1')).toBeInTheDocument()
    expect(screen.getByTestId('project-automation-view')).toHaveClass('automation-root')
    expect(screen.getByRole('heading', { name: '自动化' })).toBeInTheDocument()
    expect(screen.getByTestId('automation-create-blank')).toBeInTheDocument()
    expect(screen.getByTestId('open-template-store')).toBeInTheDocument()
    expect(projectAutomationApi.list).toHaveBeenCalledWith('11')
    expect(projectAutomationApi.listRuns).toHaveBeenCalledWith('11', 'rule-1')
    expect(deviceApi.listDevices).toHaveBeenCalled()
    expect(modelApi.listModels).toHaveBeenCalled()
    expect(pluginApi.listPlugins).toHaveBeenCalledWith('local-device')
  })

  test('opens and applies an embedded template from the template store', async () => {
    renderView()
    await screen.findByTestId('automation-card-rule-1')

    fireEvent.click(screen.getByTestId('open-template-store'))
    expect(screen.getByTestId('template-store')).toBeInTheDocument()
    expect(screen.getAllByText('每日 Issue 巡检')).not.toHaveLength(0)

    fireEvent.click(screen.getByTestId('template-card-daily-inspection'))
    fireEvent.click(screen.getByTestId('apply-selected-template'))

    expect(screen.getByTestId('automation-rule-editor')).toBeInTheDocument()
    expect(screen.getByDisplayValue('每日 Issue 巡检')).toBeInTheDocument()
    expect(screen.getByTestId('automation-workflow-canvas')).toBeInTheDocument()
  })

  test('opens a backend rule as a horizontal draggable React Flow workflow', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('automation-card-rule-1'))

    expect(screen.getByTestId('automation-rule-editor')).toBeInTheDocument()
    expect(screen.getByTestId('automation-workflow-canvas')).toBeInTheDocument()
    expect(screen.getByTestId('automation-trigger-node')).toBeInTheDocument()
    expect(screen.getByTestId('execution-node-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('ai-allocation-node-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('execution-node-step-3')).toBeInTheDocument()
    expect(screen.getByTestId('automation-editor-leftbar')).toBeInTheDocument()
    expect(screen.getByTestId('automation-editor-rightbar')).toContainElement(
      screen.getByTestId('automation-editor-global-actions')
    )
  })

  test('keeps persisted AI dynamic allocation as a DAG subgraph', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('automation-card-rule-1'))
    fireEvent.click(screen.getByTestId('ai-allocation-node-step-2'))

    expect(screen.getByText('AI 动态分配 · DAG 子图')).toBeInTheDocument()
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-analysis')).toBeInTheDocument()
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-delivery')).toBeInTheDocument()
  })

  test('shows backend run history inside the current automation', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('automation-card-rule-1'))
    fireEvent.click(screen.getByTestId('open-current-automation-runs'))

    expect(screen.getByTestId('current-automation-runs')).toBeInTheDocument()
    expect(screen.getAllByText('WEG-842 统一自动化概念')).not.toHaveLength(0)
  })

  test('promotes a legacy Issue workflow on its first save', async () => {
    const legacyProject = {
      ...project,
      version: 4,
      updated_at: '2026-08-25T02:32:00Z',
      workflow_definition: {
        version: 3,
        stage_mode: 'dag',
        advancement_policy: 'manual',
        coordinator_prompt: '',
        approval_policy: 'required',
        ai_automation_rule_id: null,
        execution_config: null,
        nodes: [
          {
            id: 'implement',
            name: '实现',
            prompt: '完成 Issue 中的要求',
            execution_mode: 'human',
            depends_on: [],
            dependency_context: {},
            required: true,
            required_deliverables: [],
            workspace_policy: 'composer',
            automation_rule_id: null,
            execution_config: null,
            execution_config_override: false,
          },
        ],
      },
    } as CloudProject
    const onProjectUpdated = vi.fn()
    const { projectAutomationApi } = renderView({
      viewProject: legacyProject,
      listedRules: [],
      onProjectUpdated,
    })

    fireEvent.click(await screen.findByTestId('automation-card-legacy-workflow-11'))
    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.migrateWorkflow).toHaveBeenCalledOnce())
    expect(projectAutomationApi.migrateWorkflow).toHaveBeenCalledWith(
      '11',
      expect.objectContaining({
        projectVersion: 4,
        workflowDefinition: expect.objectContaining({
          version: 3,
          nodes: [expect.objectContaining({ id: 'implement' })],
        }),
      })
    )
    expect(onProjectUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_automation_id: 'rule-migrated',
        version: 5,
      })
    )
    expect(await screen.findByTestId('execution-node-implement')).toBeInTheDocument()
  })

  test('keeps a canonical AI workflow visible when it references itself', async () => {
    const canonicalRule: ProjectAutomationRule = {
      ...rule,
      id: 'canonical-rule',
      eventConfig: {
        ...rule.eventConfig,
        runtime_workflow_definition: {
          version: 4,
          stage_mode: 'dag',
          advancement_policy: 'ai',
          coordinator_prompt: '动态规划',
          approval_policy: 'required',
          ai_automation_rule_id: 'canonical-rule',
          execution_config: null,
          nodes: [],
        },
      },
    }
    renderView({
      viewProject: {
        ...project,
        workflow_automation_id: 'canonical-rule',
      } as CloudProject,
      listedRules: [canonicalRule],
    })

    expect(await screen.findByTestId('automation-card-canonical-rule')).toBeInTheDocument()
  })
})
