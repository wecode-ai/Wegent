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
  listedRuns = [run],
  onProjectUpdated,
}: {
  viewProject?: CloudProject
  listedRules?: ProjectAutomationRule[]
  listedRuns?: ProjectAutomationRun[]
  onProjectUpdated?: (project: CloudProject) => void
} = {}) {
  const projectAutomationApi = {
    list: vi.fn().mockResolvedValue(listedRules),
    listRuns: vi.fn().mockResolvedValue(listedRuns),
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
  const view = render(
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
  return { projectAutomationApi, deviceApi, modelApi, pluginApi, view }
}

async function openRuleEditor(ruleId = 'rule-1') {
  fireEvent.click(await screen.findByTestId(`automation-card-${ruleId}`))
  return screen.findByTestId('automation-rule-editor')
}

describe('ProjectAutomationView', () => {
  test('renders rules without loading runs or execution catalogs', async () => {
    const { projectAutomationApi, deviceApi, modelApi, pluginApi } = renderView()

    expect(await screen.findByTestId('automation-card-rule-1')).toBeInTheDocument()
    expect(screen.getByTestId('project-automation-view')).toHaveClass('automation-root')
    expect(screen.getByRole('heading', { name: '自动化' })).toBeInTheDocument()
    expect(screen.getByTestId('automation-create-blank')).toBeInTheDocument()
    expect(screen.getByTestId('open-template-store')).toBeInTheDocument()
    expect(projectAutomationApi.list).toHaveBeenCalledWith('11')
    expect(projectAutomationApi.listRuns).not.toHaveBeenCalled()
    expect(deviceApi.listDevices).not.toHaveBeenCalled()
    expect(modelApi.listModels).not.toHaveBeenCalled()
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()
  })

  test('loads the execution catalog only after entering the editor', async () => {
    const { deviceApi, modelApi, pluginApi } = renderView()
    let resolveDevices:
      | ((devices: Awaited<ReturnType<NonNullable<typeof deviceApi>['listDevices']>>) => void)
      | null = null
    vi.mocked(deviceApi!.listDevices).mockReturnValue(
      new Promise(resolve => {
        resolveDevices = resolve
      })
    )

    const card = await screen.findByTestId('automation-card-rule-1')
    expect(deviceApi!.listDevices).not.toHaveBeenCalled()
    expect(modelApi!.listModels).not.toHaveBeenCalled()

    fireEvent.click(card)

    expect(screen.getByTestId('automation-editor-preparing')).toBeInTheDocument()
    expect(deviceApi!.listDevices).toHaveBeenCalledOnce()
    expect(modelApi!.listModels).toHaveBeenCalledOnce()
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()

    resolveDevices?.([
      {
        id: 1,
        device_id: 'local-device',
        name: '本机执行器',
        status: 'online',
        is_default: true,
        device_type: 'local',
      },
    ])

    expect(await screen.findByTestId('automation-rule-editor')).toBeInTheDocument()
    expect(pluginApi.listPlugins).toHaveBeenCalledWith('local-device')
  })

  test('renders the processing-boundary trigger semantics', async () => {
    renderView({
      listedRules: [
        {
          ...rule,
          eventType: 'task.status_changed',
          eventConfig: {
            ...rule.eventConfig,
            transition: 'entered_processing',
          },
        },
      ],
    })

    expect(await screen.findByTestId('automation-card-rule-1')).toHaveTextContent(
      'Issue 从未开始区域进入处理阶段或其后任意状态时启动'
    )
  })

  test('restores cached automation data immediately when the tab is reopened', async () => {
    const { projectAutomationApi, deviceApi, modelApi, pluginApi, view } = renderView()
    await screen.findByTestId('automation-card-rule-1')

    view.unmount()
    render(
      <ProjectAutomationView
        api={{} as NonNullable<WorkbenchServices['deliveryApi']>}
        project={project}
        projectAutomationApi={projectAutomationApi}
        deviceApi={deviceApi}
        modelApi={modelApi}
        pluginApi={pluginApi}
        currentUserId={7}
        canManageAgents
      />
    )

    expect(screen.getByTestId('automation-card-rule-1')).toBeInTheDocument()
    expect(screen.queryByText('正在加载自动化')).not.toBeInTheDocument()
    expect(projectAutomationApi.list).toHaveBeenCalledTimes(1)
    expect(projectAutomationApi.listRuns).not.toHaveBeenCalled()
    expect(deviceApi.listDevices).not.toHaveBeenCalled()
    expect(modelApi.listModels).not.toHaveBeenCalled()
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()
  })

  test('opens and applies an embedded template from the template store', async () => {
    const { deviceApi, modelApi, pluginApi } = renderView()
    await screen.findByTestId('automation-card-rule-1')

    fireEvent.click(screen.getByTestId('open-template-store'))
    expect(screen.getByTestId('template-store')).toBeInTheDocument()
    expect(screen.getAllByText('每日 Issue 巡检')).not.toHaveLength(0)

    fireEvent.click(screen.getByTestId('template-card-daily-inspection'))
    fireEvent.click(screen.getByTestId('apply-selected-template'))

    expect(await screen.findByTestId('automation-rule-editor')).toBeInTheDocument()
    expect(deviceApi.listDevices).toHaveBeenCalledOnce()
    expect(modelApi.listModels).toHaveBeenCalledOnce()
    expect(pluginApi.listPlugins).toHaveBeenCalledWith('local-device')
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    expect(screen.getByDisplayValue('每日 Issue 巡检')).toBeInTheDocument()
    expect(screen.getByTestId('automation-workflow-canvas')).toBeInTheDocument()
  })

  test('opens a backend rule as a horizontal draggable React Flow workflow', async () => {
    const { view } = renderView()
    await openRuleEditor()

    expect(screen.getByTestId('automation-workflow-canvas')).toBeInTheDocument()
    expect(screen.getByTestId('automation-trigger-node')).toBeInTheDocument()
    expect(screen.getByTestId('execution-node-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('ai-allocation-node-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('execution-node-step-3')).toBeInTheDocument()
    expect(screen.queryByTestId('automation-editor-leftbar')).not.toBeInTheDocument()
    const navigation = screen.getByTestId('automation-editor-navigation')
    const backButton = screen.getByTestId('automation-editor-back')
    const sectionMenu = screen.getByTestId('automation-editor-section-menu')
    expect(navigation).not.toHaveClass('border', 'bg-background/95', 'shadow-md')
    expect(backButton).toHaveClass('size-8', 'border', 'bg-background/95', 'shadow-md')
    expect(sectionMenu.firstElementChild).toHaveClass(
      'h-8',
      'border',
      'bg-background/95',
      'shadow-md'
    )
    expect(sectionMenu).toHaveTextContent('编排')
    expect(screen.getByTestId('automation-editor-rightbar')).not.toContainElement(
      screen.getByTestId('automation-editor-global-actions')
    )
    expect(screen.getByTestId('automation-rule-editor')).toContainElement(
      screen.getByTestId('automation-editor-global-actions')
    )
    expect(screen.queryByTestId('automation-test-run')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automation-publish')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automation-node-insert-before-trigger')).not.toBeInTheDocument()
    expect(screen.getByTestId('automation-node-insert-after-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('automation-node-insert-before-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('automation-node-insert-after-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('automation-node-insert-before-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('automation-node-insert-after-step-2')).toBeInTheDocument()
    expect(view.container.querySelector('[data-id^="append-edge:"]')).toBeNull()
    expect(view.container.querySelector('[data-id^="insert-"]')).toBeNull()
  })

  test('uses hand mode by default and allows switching to pointer mode', async () => {
    renderView()
    await openRuleEditor()

    const handMode = screen.getByTestId('automation-canvas-hand-mode')
    const pointerMode = screen.getByTestId('automation-canvas-pointer-mode')
    expect(handMode.parentElement).toHaveClass(
      'h-16',
      'w-8',
      'grid-rows-2',
      'overflow-hidden',
      'border',
      'bg-background/95',
      'shadow-md'
    )
    expect(handMode.parentElement).not.toHaveClass('gap-1', 'p-1')
    expect(handMode).toHaveClass('h-full', 'w-full')
    expect(pointerMode).toHaveClass('h-full', 'w-full')
    expect(handMode).not.toHaveClass('border', 'shadow-md')
    expect(pointerMode).not.toHaveClass('border', 'shadow-md')
    expect(handMode).toHaveClass('active')
    expect(pointerMode).not.toHaveClass('active')

    fireEvent.click(pointerMode)

    expect(pointerMode).toHaveClass('active')
    expect(handMode).not.toHaveClass('active')
  })

  test('inserts a node before an existing stage and rewires its dependencies', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-before-step-2'))
    fireEvent.click(screen.getByTestId('automation-node-insert-before-task-step-2'))

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testid^="execution-node-name-step-"]'
    )
    const promptInput = document.querySelector<HTMLTextAreaElement>(
      '[data-testid^="execution-node-prompt-step-"]'
    )
    expect(nameInput).not.toBeNull()
    expect(promptInput).not.toBeNull()
    fireEvent.change(nameInput as HTMLInputElement, { target: { value: '新增检查' } })
    fireEvent.change(promptInput as HTMLTextAreaElement, {
      target: { value: '在动态分配前完成检查。' },
    })
    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalledOnce())
    const input = vi.mocked(projectAutomationApi.update).mock.calls[0][2]
    const flow = input.eventConfig?.wework_flow as {
      graph: { nodes: Array<{ id: string; name: string; dependencies: string[] }> }
    }
    const inserted = flow.graph.nodes.find(node => node.name === '新增检查')
    const successor = flow.graph.nodes.find(node => node.id === 'step-2')
    expect(inserted).toBeDefined()
    expect(inserted?.dependencies).toEqual([])
    expect(successor?.dependencies).toEqual([inserted?.id])
  })

  test('rejects saving a workflow with an unnamed execution node', async () => {
    const { projectAutomationApi } = renderView()
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('execution-node-step-1'))
    fireEvent.change(screen.getByTestId('execution-node-name-step-1'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('automation-save'))

    expect(await screen.findByText('请填写所有执行节点名称')).toBeInTheDocument()
    expect(projectAutomationApi.update).not.toHaveBeenCalled()
  })

  test('selects the first workflow node when entering the rule editor', async () => {
    renderView()
    await openRuleEditor()

    expect(screen.getByTestId('automation-trigger-node')).toHaveClass('selected')
    expect(screen.getByTestId('automation-editor-rightbar')).toBeInTheDocument()
  })

  test('hides the workflow detail panel after clearing the node selection', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-workflow-canvas'))

    expect(screen.queryByTestId('automation-editor-rightbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('automation-rule-editor')).toHaveStyle({
      '--automation-right-panel-width': '0px',
    })
  })

  test('closes the workflow detail panel from its header action', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-editor-close-rightbar'))

    expect(screen.queryByTestId('automation-editor-rightbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('automation-rule-editor')).toHaveStyle({
      '--automation-right-panel-width': '0px',
    })
  })

  test('keeps persisted AI dynamic allocation as a DAG subgraph', async () => {
    renderView()
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('ai-allocation-node-step-2'))

    expect(screen.getByText('AI 动态分配 · DAG 子图')).toBeInTheDocument()
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-analysis')).toBeInTheDocument()
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-delivery')).toBeInTheDocument()
  })

  test('shows backend run history inside the current automation', async () => {
    renderView()
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    fireEvent.click(screen.getByTestId('open-current-automation-runs'))

    expect(screen.getByTestId('current-automation-runs')).toBeInTheDocument()
    expect(await screen.findAllByText('WEG-842 统一自动化概念')).not.toHaveLength(0)
  })

  test('shows queued and waiting runtime states without calling them running', async () => {
    const waitingRun: ProjectAutomationRun = {
      ...run,
      id: 'run-waiting-runtime',
      projectId: '12',
      status: 'waiting_runtime',
      taskTitle: '等待配置的 Issue',
      completedAt: null,
    }
    renderView({
      viewProject: { ...project, id: 12 } as CloudProject,
      listedRuns: [waitingRun],
    })
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    fireEvent.click(screen.getByTestId('open-current-automation-runs'))

    const row = await screen.findByTestId('current-run-run-waiting-runtime')
    expect(row).toHaveTextContent('待配置')
    expect(row).toHaveTextContent('—')
    expect(row).not.toHaveTextContent('执行中')
  })

  test('refreshes run history when the visible desktop regains focus', async () => {
    const queuedRun: ProjectAutomationRun = {
      ...run,
      id: 'run-refresh',
      projectId: '13',
      status: 'queued',
      taskTitle: '刷新状态的 Issue',
      completedAt: null,
    }
    const { projectAutomationApi } = renderView({
      viewProject: { ...project, id: 13 } as CloudProject,
      listedRuns: [queuedRun],
    })
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    fireEvent.click(screen.getByTestId('open-current-automation-runs'))
    expect(await screen.findByTestId('current-run-run-refresh')).toHaveTextContent('排队中')

    vi.mocked(projectAutomationApi.listRuns).mockResolvedValue([
      {
        ...queuedRun,
        status: 'succeeded',
        completedAt: '2026-08-25T02:38:18Z',
      },
    ])
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() =>
      expect(screen.getByTestId('current-run-run-refresh')).toHaveTextContent('成功')
    )
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

    await openRuleEditor('legacy-workflow-11')
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

  test('loads only root runs for a canonical workflow', async () => {
    const canonicalRule: ProjectAutomationRule = {
      ...rule,
      id: 'root-rule',
      projectId: '21',
      eventConfig: {
        ...rule.eventConfig,
        runtime_workflow_definition: {
          version: 1,
          stage_mode: 'dag',
          advancement_policy: 'manual',
          coordinator_prompt: '',
          approval_policy: 'required',
          ai_automation_rule_id: null,
          execution_config: null,
          nodes: [
            {
              id: 'execute',
              name: 'Execute',
              prompt: 'Execute the Issue',
              execution_mode: 'robot',
              depends_on: [],
              required: true,
              workspace_policy: 'composer',
              automation_rule_id: 'internal-rule',
            },
          ],
        },
      },
    }
    const internalRule: ProjectAutomationRule = {
      ...rule,
      id: 'internal-rule',
      projectId: '21',
      triggerType: 'workflow',
    }
    const { projectAutomationApi } = renderView({
      viewProject: {
        ...project,
        id: 21,
        workflow_automation_id: 'root-rule',
      } as CloudProject,
      listedRules: [canonicalRule, internalRule],
      listedRuns: [{ ...run, automationId: 'root-rule', projectId: '21' }],
    })

    expect(await screen.findByTestId('automation-card-root-rule')).toBeInTheDocument()
    await openRuleEditor('root-rule')
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    fireEvent.click(screen.getByTestId('open-current-automation-runs'))
    await waitFor(() => expect(projectAutomationApi.listRuns).toHaveBeenCalledTimes(1))
    expect(projectAutomationApi.listRuns).toHaveBeenCalledTimes(1)
    expect(projectAutomationApi.listRuns).toHaveBeenCalledWith('21', 'root-rule')
  })
})
