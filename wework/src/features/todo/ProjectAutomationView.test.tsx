import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectAutomationRule, ProjectAutomationRun } from '@/api/projectAutomations'
import { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { AutomationRulesView } from './AutomationRulesView.jsx'
import { automationRuleFromBackend } from './automationRuleBackend'
import { ProjectAutomationView } from './ProjectAutomationView'

const localExecutorMocks = vi.hoisted(() => ({
  getLocalExecutorStatus: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => ({
  getLocalExecutorStatus: localExecutorMocks.getLocalExecutorStatus,
}))

const project = {
  id: 11,
  name: 'Automation project',
  current_user_id: 7,
  tags: ['自动开发', '缺陷'],
  task_provider: 'gitlab',
  provider_config: {
    domain: 'gitlab.example',
    repository: 'Test-Gitlab',
    credential_configured: true,
  },
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
  Object.defineProperty(window, 'DOMMatrixReadOnly', {
    configurable: true,
    value: class DOMMatrixReadOnly {
      m22 = 1
    },
  })
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

beforeEach(() => {
  localExecutorMocks.getLocalExecutorStatus.mockReset()
  localExecutorMocks.getLocalExecutorStatus.mockResolvedValue({
    running: true,
    ready: true,
    deviceId: 'local-device',
  })
})

function renderView({
  viewProject = project,
  listedRules = [rule],
  listedRuns = [run],
  onProjectUpdated,
  incomingHookApi,
  modelApi,
}: {
  viewProject?: CloudProject
  listedRules?: ProjectAutomationRule[]
  listedRuns?: ProjectAutomationRun[]
  onProjectUpdated?: (project: CloudProject) => void
  incomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
  modelApi?: WorkbenchServices['modelApi']
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
  const modelApiOrDefault =
    modelApi ??
    ({
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
    } as unknown as WorkbenchServices['modelApi'])
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
  const projectAutomationView = (
    updatedCallback: ((project: CloudProject) => void) | undefined = onProjectUpdated
  ) => (
    <ProjectAutomationView
      api={{} as NonNullable<WorkbenchServices['deliveryApi']>}
      project={viewProject}
      projectAutomationApi={projectAutomationApi}
      projectIncomingHookApi={incomingHookApi}
      deviceApi={deviceApi}
      modelApi={modelApiOrDefault}
      pluginApi={pluginApi}
      currentUserId={7}
      canManageAgents
      onProjectUpdated={updatedCallback}
    />
  )
  const view = render(projectAutomationView())
  return {
    projectAutomationApi,
    deviceApi,
    modelApi: modelApiOrDefault,
    pluginApi,
    view,
    rerender: (updatedCallback?: (project: CloudProject) => void) =>
      view.rerender(projectAutomationView(updatedCallback)),
  }
}

async function openRuleEditor(ruleId = 'rule-1') {
  fireEvent.click(await screen.findByTestId(`automation-card-${ruleId}`))
  return screen.findByTestId('automation-rule-editor')
}

function refreshedFirstStepPrompt(
  current: ReturnType<typeof automationRuleFromBackend>,
  prompt: string
) {
  return {
    ...current,
    version: current.version + 1,
    steps: current.steps.map((step, index) => (index === 0 ? { ...step, prompt } : step)),
  }
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

  test('opens the editor immediately while loading devices and models in the background', async () => {
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

    expect(screen.getByTestId('automation-rule-editor')).toBeInTheDocument()
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

    await waitFor(() => expect(deviceApi!.listDevices).toHaveBeenCalledOnce())
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()
  })

  test('loads plugins only when the plugin selector is opened', async () => {
    const { pluginApi } = renderView()

    await openRuleEditor()
    fireEvent.click(screen.getByTestId('execution-node-step-1'))
    fireEvent.click(screen.getByTestId('execution-node-add-plugin-step-1'))

    await waitFor(() => {
      expect(pluginApi.listPlugins).toHaveBeenCalledWith('local-device')
    })
  })

  test('closes the plugin selector on outside click and Escape', async () => {
    renderView()

    await openRuleEditor()
    fireEvent.click(screen.getByTestId('execution-node-step-1'))

    const trigger = screen.getByTestId('execution-node-add-plugin-step-1')
    fireEvent.click(trigger)
    expect(screen.getByTestId('execution-node-add-plugin-step-1-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('execution-node-add-plugin-step-1-menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByTestId('execution-node-add-plugin-step-1-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('execution-node-add-plugin-step-1-menu')).not.toBeInTheDocument()
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

  test('does not reload automation rules when a parent callback changes', async () => {
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const { projectAutomationApi, rerender } = renderView({ onProjectUpdated: vi.fn() })
      expect(await screen.findByTestId('automation-card-rule-1')).toBeInTheDocument()
      expect(projectAutomationApi.list).toHaveBeenCalledOnce()

      now += 31_000
      rerender(vi.fn())
      await act(async () => {
        await Promise.resolve()
      })

      expect(projectAutomationApi.list).toHaveBeenCalledOnce()
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('preserves a dirty editor draft when refreshed rules arrive', async () => {
    const initialRule = automationRuleFromBackend(rule)
    const refreshedRule = refreshedFirstStepPrompt(initialRule, '服务端刷新内容')
    const view = render(<AutomationRulesView rules={[initialRule]} runs={[]} />)
    fireEvent.click(screen.getByTestId('automation-card-rule-1'))
    fireEvent.click(screen.getByTestId('execution-node-step-1'))
    fireEvent.change(screen.getByTestId('execution-node-prompt-step-1'), {
      target: { value: '尚未保存的本地输入' },
    })

    view.rerender(<AutomationRulesView rules={[refreshedRule]} runs={[]} />)

    expect(screen.getByTestId('execution-node-prompt-step-1')).toHaveValue('尚未保存的本地输入')
    expect(screen.getByText('有未保存更改')).toBeInTheDocument()
  })

  test('applies a refreshed rule when the editor draft is clean', async () => {
    const initialRule = automationRuleFromBackend(rule)
    const refreshedRule = refreshedFirstStepPrompt(initialRule, '服务端刷新内容')
    const view = render(<AutomationRulesView rules={[initialRule]} runs={[]} />)
    fireEvent.click(screen.getByTestId('automation-card-rule-1'))
    fireEvent.click(screen.getByTestId('execution-node-step-1'))

    view.rerender(<AutomationRulesView rules={[refreshedRule]} runs={[]} />)

    expect(screen.getByTestId('execution-node-prompt-step-1')).toHaveValue('服务端刷新内容')
    expect(screen.queryByText('有未保存更改')).not.toBeInTheDocument()
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
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()
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

  test('shows understandable local and cloud execution device names', async () => {
    const { deviceApi } = renderView()
    vi.mocked(deviceApi.listDevices).mockResolvedValue([
      {
        id: 1,
        device_id: 'local-device',
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'local',
      },
      {
        id: 2,
        device_id: 'cloud-verify-device',
        name: 'Cloud Verify Device',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
      },
    ] as never)

    await openRuleEditor()
    fireEvent.click(screen.getByTestId('execution-node-step-1'))

    const environmentSelect = screen.getByTestId('execution-node-environment-step-1')
    expect(environmentSelect).toHaveTextContent('本机')
    expect(environmentSelect.querySelector('.lucide-laptop')).toBeInTheDocument()
    expect(environmentSelect).not.toHaveTextContent('Local Executor')
    expect(environmentSelect).not.toHaveTextContent('在线')

    fireEvent.click(environmentSelect)

    const localOption = screen.getByTestId('execution-node-environment-step-1-option-local-device')
    const cloudOption = screen.getByTestId(
      'execution-node-environment-step-1-option-cloud-verify-device'
    )
    expect(localOption).toHaveTextContent('本机')
    expect(localOption.querySelector('.lucide-laptop')).toBeInTheDocument()
    expect(cloudOption).toHaveTextContent('Cloud Verify Device')
    expect(cloudOption.querySelector('.lucide-cloud')).toBeInTheDocument()
    expect(screen.queryByText('Local Executor')).not.toBeInTheDocument()
    expect(screen.queryByText('在线')).not.toBeInTheDocument()

    fireEvent.click(cloudOption)

    expect(environmentSelect).toHaveTextContent('Cloud Verify Device')
    expect(environmentSelect.querySelector('.lucide-cloud')).toBeInTheDocument()
  })

  test('clears execution environment and model and persists the unconfigured node', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('execution-node-step-1'))

    const environmentSelect = screen.getByTestId('execution-node-environment-step-1')
    fireEvent.click(environmentSelect)
    fireEvent.click(screen.getByTestId('execution-node-environment-step-1-option-none'))
    expect(environmentSelect).toHaveTextContent('选择执行环境')
    expect(environmentSelect.querySelector('[data-value]')).toHaveAttribute('data-value', '')

    const modelSelect = screen.getByTestId('execution-node-model-step-1')
    fireEvent.change(modelSelect, { target: { value: '' } })
    expect(modelSelect).toHaveValue('')
    expect(screen.getByRole('option', { name: '不指定模型' })).not.toBeDisabled()

    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalledOnce())
    const input = vi.mocked(projectAutomationApi.update).mock.calls[0][2]
    const storedNode = (
      input.eventConfig?.wework_flow as {
        graph: {
          nodes: Array<{
            environment: string
            executionDeviceId: string | null
            runtimeProfileId: string | null
            model: string
            modelType: string | null
            modelOptions: Record<string, string>
          }>
        }
      }
    ).graph.nodes[0]
    const runtimeNode = input.eventConfig?.runtime_workflow_definition?.nodes[1]

    expect(storedNode).toMatchObject({
      environment: '',
      executionDeviceId: null,
      runtimeProfileId: null,
      model: '',
      modelType: null,
      modelOptions: {},
    })
    expect(runtimeNode?.execution_config).toMatchObject({
      execution_device_id: null,
      runtime_profile_id: null,
      model: null,
      model_type: null,
      model_options: {},
    })
  })

  test('persists the cloud model identity in workflow model options', async () => {
    const { projectAutomationApi } = renderView({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'dpskv4f',
              displayName: 'deepseekv4flash',
              type: 'user',
              namespace: 'default',
              resourceUserId: 1,
              isActive: true,
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
              },
            },
          ],
        }),
      } as unknown as WorkbenchServices['modelApi'],
    })
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('execution-node-step-1'))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'deepseekv4flash' })).toBeInTheDocument()
    )
    fireEvent.change(screen.getByTestId('execution-node-model-step-1'), {
      target: { value: 'dpskv4f' },
    })
    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalledOnce())
    const input = vi.mocked(projectAutomationApi.update).mock.calls[0][2]
    const storedNode = (
      input.eventConfig?.wework_flow as {
        graph: {
          nodes: Array<{
            model: string
            modelType: string | null
            modelOptions: Record<string, string>
          }>
        }
      }
    ).graph.nodes[0]
    expect(storedNode).toMatchObject({
      model: 'dpskv4f',
      modelType: 'user',
      modelOptions: {
        protocol: 'openai-responses',
        apiFormat: 'responses',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '1',
      },
    })
  })

  test('removes legacy executor names and trailing separators from workflow nodes', async () => {
    renderView({
      listedRules: [
        {
          ...rule,
          eventConfig: {
            ...rule.eventConfig,
            wework_flow: {
              ...rule.eventConfig.wework_flow,
              steps: [
                {
                  ...rule.eventConfig.wework_flow.steps[0],
                  environment: 'Local Executor · 在线',
                  model: '',
                },
              ],
            },
          },
        },
      ],
    })

    await openRuleEditor()

    const node = screen.getByTestId('execution-node-step-1')
    expect(node).toHaveTextContent('本机')
    expect(node).not.toHaveTextContent('Local Executor')
    expect(node).not.toHaveTextContent('在线')
    expect(node).not.toHaveTextContent('本机 ·')
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

  test('selects and persists the required deliverable type', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('execution-node-step-1'))
    fireEvent.click(screen.getByTestId('execution-node-add-deliverable-step-1'))

    const typeSelect = screen.getByRole('combobox', { name: /交付物类型/ })
    fireEvent.change(typeSelect, { target: { value: 'file' } })
    expect(typeSelect).toHaveValue('file')

    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalledOnce())
    const input = vi.mocked(projectAutomationApi.update).mock.calls[0][2]
    const flow = input.eventConfig?.wework_flow as {
      graph: {
        nodes: Array<{
          deliverables: Array<{
            valueType: string
            fileConstraints: {
              accepted_types: string[]
              min_files: number
              max_files: number
            } | null
          }>
        }>
      }
    }
    const workflow = input.eventConfig?.runtime_workflow_definition

    expect(flow.graph.nodes[0]?.deliverables[0]).toMatchObject({
      valueType: 'file',
      fileConstraints: {
        accepted_types: [],
        min_files: 1,
        max_files: 1,
      },
    })
    expect(workflow?.nodes[1]?.required_deliverables?.[0]).toMatchObject({
      value_type: 'file',
      file_constraints: {
        accepted_types: [],
        min_files: 1,
        max_files: 1,
      },
    })
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

  test('inserts a loop container and renders its loop body', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))

    expect(await screen.findByTestId(/^loop-node-loop-/)).toBeInTheDocument()
    expect(screen.getByTestId(/^loop-body-node-/)).toBeInTheDocument()
    const loopMain = screen.getByTestId(/^loop-node-main-/)
    expect(loopMain).toHaveTextContent('循环')
    expect(loopMain).toHaveTextContent('最多 5 次')
  })

  test('inserts a branch node inside a loop and renders condition rows', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))
    expect(await screen.findByTestId(/^loop-node-loop-/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(/^automation-node-insert-after-loop-start-/))
    fireEvent.click(screen.getByTestId(/^automation-node-insert-after-branch-loop-start-/))

    const branchNode = await screen.findByTestId(/^loop-body-node-loop-body-/)
    const branchId = branchNode.getAttribute('data-testid').replace('loop-body-node-', '')
    expect(
      await screen.findByText('还没有分支，可通过分支节点右侧的加号添加。')
    ).toBeInTheDocument()
    expect(await screen.findByTestId('branch-node-name')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))

    expect((await screen.findAllByText('分支 1')).length).toBeGreaterThan(0)
  })

  test('creates another branch from the right plus of a branch inside a loop', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))
    fireEvent.click(await screen.findByTestId(/^automation-node-insert-after-loop-start-/))
    fireEvent.click(screen.getByTestId(/^automation-node-insert-after-branch-loop-start-/))

    const branchNode = await screen.findByTestId(/^loop-body-node-loop-body-/)
    const branchId = branchNode.getAttribute('data-testid').replace('loop-body-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-branch-${branchId}`))

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId(/^loop-body-node-/)
          .filter(node => node.textContent?.includes('按事件路由'))
      ).toHaveLength(2)
    )
  })

  test('creates a loop end from the right plus of a branch inside a loop', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))
    fireEvent.click(await screen.findByTestId(/^automation-node-insert-after-loop-start-/))
    fireEvent.click(screen.getByTestId(/^automation-node-insert-after-branch-loop-start-/))

    const branchNode = await screen.findByTestId(/^loop-body-node-loop-body-/)
    const branchId = branchNode.getAttribute('data-testid').replace('loop-body-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-loopEnd-${branchId}`))

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId(/^loop-body-node-/)
          .some(node => node.getAttribute('aria-label') === '循环结束')
      ).toBe(true)
    )
  })

  test('persists loop max attempts and timeout without loop variables or break conditions', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))
    fireEvent.click(await screen.findByTestId(/^loop-node-main-loop-/))

    expect(screen.queryByTestId('loop-variable-add')).not.toBeInTheDocument()
    expect(screen.queryByTestId('loop-break-add')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('loop-max-attempts'), { target: { value: '8' } })
    fireEvent.change(screen.getByTestId('loop-timeout-seconds'), { target: { value: '600' } })

    fireEvent.click(screen.getByTestId('automation-save'))
    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalledOnce())

    const input = vi.mocked(projectAutomationApi.update).mock.calls[0][2]
    const flow = input.eventConfig?.wework_flow as {
      graph: { nodes: Array<{ nodeType: string; loopConfig: Record<string, unknown> }> }
    }
    const loop = flow.graph.nodes.find(node => node.nodeType === 'loop')
    expect(loop?.loopConfig).toMatchObject({
      maxAttempts: 8,
      timeoutSeconds: 600,
    })
  })

  test('inserts a top-level branch node and creates a branch handler', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    expect(await screen.findByTestId(/^branch-node-branch-/)).toBeInTheDocument()
    expect(screen.getByText('完成后继续')).toBeInTheDocument()

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))
    expect((await screen.findAllByText('分支 1')).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId(/^execution-node-step-/)).toHaveLength(3)
    expect(await screen.findByTestId('branch-node-name')).toBeInTheDocument()
  })

  test('creates a branch handler from the right plus with the next available event', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))

    expect((await screen.findAllByText('分支 1')).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId(/^execution-node-step-/)).toHaveLength(3)
    expect(await screen.findByTestId('branch-node-name')).toBeInTheDocument()
  })

  test('offers every supported top-level node type from the branch right plus', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    ;['task', 'dynamic', 'loop', 'branch'].forEach(kind => {
      expect(
        screen.getByTestId(`automation-node-insert-after-${kind}-${branchId}`)
      ).toBeInTheDocument()
    })
  })

  test('offers branch and loop-end handlers inside a loop branch', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))
    fireEvent.click(await screen.findByTestId(/^automation-node-insert-after-loop-start-/))
    fireEvent.click(screen.getByTestId(/^automation-node-insert-after-branch-loop-start-/))

    const branchNode = await screen.findByTestId(/^loop-body-node-loop-body-/)
    const branchId = branchNode.getAttribute('data-testid').replace('loop-body-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    ;['task', 'branch', 'loopEnd'].forEach(kind => {
      expect(
        screen.getByTestId(`automation-node-insert-after-${kind}-${branchId}`)
      ).toBeInTheDocument()
    })
  })

  test('creates a branch handler from the right plus and switches to branch settings', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.update = vi.fn().mockResolvedValue(rule)
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))

    expect((await screen.findAllByText('分支 1')).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId(/^execution-node-step-/)).toHaveLength(3)
    expect(await screen.findByTestId('branch-node-name')).toBeInTheDocument()
  })

  test('stacks branch condition handlers downward in a single column', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))

    const readPosition = handle => {
      const node = handle?.closest('.react-flow__node')
      if (!node) return null
      const match = (node.style.transform || '').match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null
    }
    const positions = screen
      .getAllByTestId(/^execution-node-step-/)
      .map(readPosition)
      .filter(Boolean)

    // The two condition handlers share the column's x and stack by y.
    const ysByX = new Map<number, number[]>()
    positions.forEach(position => {
      const ys = ysByX.get(position.x) ?? []
      ys.push(position.y)
      ysByX.set(position.x, ys)
    })
    expect([...ysByX.values()].some(ys => new Set(ys).size >= 2)).toBe(true)
  })

  test('shows the localized label for the merged event type on a branch node', async () => {
    const incomingHookApi = {
      catalog: vi.fn().mockResolvedValue([
        {
          sourceType: 'gitlab',
          collectionModes: ['webhook', 'poll', 'hybrid'],
          resourceTypes: ['project'],
          eventTypes: ['change_request.merged', 'change_request.checks_failed'],
          executionTargets: ['continue_binding', 'create_issue'],
          nameKey: 'event_sources.gitlab.name',
          descriptionKey: 'event_sources.gitlab.description',
        },
      ]),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>

    renderView({ incomingHookApi })
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))
    fireEvent.click(screen.getByTestId(`branch-node-main-${branchId}`))
    await waitFor(() =>
      expect(screen.getByTestId('branch-condition-source-0')).toHaveValue('gitlab')
    )
    await waitFor(() =>
      expect(screen.getByTestId('branch-condition-event-0')).toHaveValue('change_request.merged')
    )

    expect((await screen.findAllByText(/分支 1/)).length).toBeGreaterThan(0)
    // The branch row applies eventTypeLabel instead of the raw identifier.
    const branchRow = screen
      .getAllByText(/分支 1/)
      .map(element => element.closest('.react-flow-branch-condition-row'))
      .find(Boolean)
    expect(branchRow?.textContent).not.toContain('change_request.merged')
  })

  test('places a node inserted after a loop to the right of its rendered width', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-loop-trigger'))

    const loopNode = await screen.findByTestId(/^loop-node-loop-/)
    const loopId = loopNode.getAttribute('data-testid').replace('loop-node-', '')

    const readPosition = handle => {
      const node = handle?.closest('.react-flow__node')
      if (!node) return null
      const match = (node.style.transform || '').match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null
    }
    const loopPosition = readPosition(loopNode)

    // Insert a task node immediately after the loop.
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${loopId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${loopId}`))

    const loopNodeEl = loopNode.closest('.react-flow__node')
    const loopWidth = Number.parseFloat(loopNodeEl?.style.width || '560')

    expect(loopPosition?.x).not.toBeNull()
    const loopLeft = loopPosition?.x ?? 0
    await waitFor(() => {
      // The node inserted after the loop must clear the loop's rendered width,
      // and no execution node may fall inside the loop's horizontal span.
      const positions = screen
        .getAllByTestId(/^execution-node-step-/)
        .map(readPosition)
        .filter(Boolean)
      expect(positions.some(position => position.x >= loopLeft + loopWidth)).toBe(true)
      positions.forEach(position => {
        expect(position.x < loopLeft || position.x >= loopLeft + loopWidth).toBe(true)
      })
    })
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

  test('opens branch settings when the branch body is pressed', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))
    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    fireEvent.click(branchNode)

    expect(await screen.findByTestId('branch-event-wait-mode')).toBeInTheDocument()
    expect(branchNode).toHaveClass('selected')
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

    const group = screen.getByTestId('ai-allocation-node-step-2')
    expect(screen.getByText('AI 动态分配 · DAG 子图')).toBeInTheDocument()
    fireEvent.click(group.querySelector('.react-flow-group-header')!)
    expect(screen.getByTestId('ai-coordinator-approval-required')).toHaveClass('selected')
    expect(screen.getByText('人工确认后执行')).toBeInTheDocument()
    expect(group.querySelector('.react-flow-group-header')).toHaveClass('rounded-t-2xl')
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-analysis')).toBeInTheDocument()
    expect(screen.getByTestId('dag-stage-node-dag-stage-step-2-delivery')).toBeInTheDocument()
    expect(
      screen
        .getByTestId('dag-stage-container-dag-stage-step-2-analysis')
        .querySelector('.react-flow-stage-handle')
    ).toHaveClass('!top-1/2')
  })

  test('edits DAG stages as constraints without per-stage runtime configuration', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('dag-stage-node-dag-stage-step-2-delivery'))

    expect(screen.getByText('阶段名称')).toBeInTheDocument()
    expect(screen.getByText('阶段目标与约束')).toBeInTheDocument()
    expect(screen.getByText('阶段执行偏好')).toBeInTheDocument()
    expect(
      screen.getByText(
        '这里只约束阶段由人工还是机器人执行；具体执行环境、模型和插件由 AI 调度器在运行时选择。'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('execution-node-environment-dag-stage-step-2-delivery')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('execution-node-model-dag-stage-step-2-delivery')
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId(
        'dag-stage-context-dag-stage-step-2-delivery-dag-stage-step-2-analysis-final_result'
      )
    ).toBeChecked()
  })

  test('saves an empty AI allocation as unconstrained Issue planning', async () => {
    const { projectAutomationApi } = renderView()
    projectAutomationApi.create = vi.fn().mockImplementation((_projectId, input) =>
      Promise.resolve({
        ...rule,
        id: 'rule-unconstrained',
        name: input.name,
        prompt: input.prompt,
        eventConfig: input.eventConfig,
      })
    )
    await screen.findByTestId('automation-card-rule-1')

    fireEvent.click(screen.getByTestId('automation-create-blank'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-dynamic-trigger'))

    const compactNode = screen.getByTestId(/ai-allocation-node-/)
    expect(screen.getByText('AI 动态分配 · 无约束')).toBeInTheDocument()
    expect(screen.getByTestId(/dag-stage-add-first-/)).toHaveTextContent('添加编排约束')
    expect(compactNode.closest('.react-flow__node')).toHaveStyle({
      width: '300px',
      height: '132px',
    })
    fireEvent.click(screen.getByTestId('ai-coordinator-environment'))
    fireEvent.click(await screen.findByTestId('ai-coordinator-environment-option-local-device'))
    fireEvent.change(screen.getByTestId('ai-coordinator-model'), {
      target: { value: 'codex-runtime' },
    })
    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.create).toHaveBeenCalledOnce())
    const input = vi.mocked(projectAutomationApi.create).mock.calls[0][1]
    expect(input.eventConfig?.runtime_workflow_definition).toMatchObject({
      stage_mode: 'none',
      advancement_policy: 'ai',
      nodes: [],
    })
  })

  test('creates an empty AI allocation and lets the user add its first DAG stage', async () => {
    const { view } = renderView()
    await screen.findByTestId('automation-card-rule-1')

    fireEvent.click(screen.getByTestId('automation-create-blank'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-dynamic-trigger'))

    const addFirstStage = view.container.querySelector<HTMLElement>(
      '[data-testid^="dag-stage-add-first-"]'
    )
    expect(addFirstStage).not.toBeNull()
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')
    const viewportTransform = viewport?.style.transform
    expect(screen.getByTestId(/ai-allocation-node-/).closest('.react-flow__node')).toHaveStyle({
      width: '300px',
      height: '132px',
    })
    expect(view.container.querySelector('[data-testid^="dag-stage-node-"]')).toBeNull()

    fireEvent.click(addFirstStage!)

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid^="dag-stage-node-"]')).toHaveLength(1)
    )
    expect(view.container.querySelector('[data-testid^="dag-stage-add-first-"]')).toBeNull()
    expect(view.container.querySelector('[data-testid^="dag-stage-insert-after-"]')).not.toBeNull()
    expect(screen.getByTestId(/ai-allocation-node-/)).toHaveClass('react-flow-dynamic-group')
    expect(viewport?.style.transform).toBe(viewportTransform)

    const dynamicSettings = screen.getByTestId('ai-coordinator-prompt')
    expect(dynamicSettings).toBeInTheDocument()
  })

  test('renders consecutive inserted steps at distinct positions instead of stacking', async () => {
    const { view } = renderView()
    await screen.findByTestId('automation-card-rule-1')

    fireEvent.click(screen.getByTestId('automation-create-blank'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-task-trigger'))
    await screen.findByTestId(/^execution-node-step-/)

    // Ensure the next inserted step gets a distinct id even when both clicks
    // land in the same millisecond.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2))
    })
    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-task-trigger'))

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid^="execution-node-step-"]')).toHaveLength(
        2
      )
    )
    // The draft reflows the previously inserted step out of the way, so the
    // rendered React Flow positions must differ instead of stacking on top of
    // each other (the originally reported "nodes disappear" symptom).
    await waitFor(() => {
      const rendered = Array.from(
        view.container.querySelectorAll<HTMLElement>('.react-flow__node')
      ).map(node => ({
        id: node.getAttribute('data-id'),
        transform: node.style.transform,
      }))
      expect(
        new Set(
          rendered
            .filter(entry => entry.id?.startsWith('step-'))
            .map(entry => entry.transform)
            .filter(Boolean)
        ).size
      ).toBe(2)
    })
    const transforms = Array.from(
      view.container.querySelectorAll<HTMLElement>('[data-testid^="execution-node-step-"]')
    ).map(step => step.closest('.react-flow__node')?.style.transform)

    expect(new Set(transforms.filter(Boolean)).size).toBe(2)
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
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
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
    await act(async () => {
      await Promise.resolve()
    })

    vi.mocked(projectAutomationApi.listRuns).mockResolvedValue([
      {
        ...queuedRun,
        status: 'succeeded',
        completedAt: '2026-08-25T02:38:18Z',
      },
    ])
    visibilityState.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))

    try {
      await waitFor(() => {
        expect(projectAutomationApi.listRuns).toHaveBeenCalledTimes(2)
        expect(screen.getByTestId('current-run-run-refresh')).toHaveTextContent('成功')
      })
    } finally {
      visibilityState.mockRestore()
    }
  })

  test('promotes a legacy Issue workflow as soon as automation rules load', async () => {
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
      listedRules: [{ ...rule, id: 'rule-secondary', name: '另一条自动化' }],
      onProjectUpdated,
    })

    await waitFor(() => expect(projectAutomationApi.migrateWorkflow).toHaveBeenCalledOnce())
    expect(projectAutomationApi.migrateWorkflow).toHaveBeenCalledWith(
      '11',
      expect.objectContaining({
        projectVersion: 4,
        workflowDefinition: expect.objectContaining({
          version: 3,
          nodes: expect.arrayContaining([expect.objectContaining({ id: 'implement' })]),
        }),
      })
    )
    expect(onProjectUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_automation_id: 'rule-migrated',
        version: 5,
      })
    )
    expect(screen.queryByTestId('automation-card-legacy-workflow-11')).not.toBeInTheDocument()
    expect(await screen.findByTestId('automation-card-rule-migrated')).toBeInTheDocument()
    expect(screen.getByTestId('automation-card-rule-secondary')).toBeInTheDocument()
    await openRuleEditor('rule-migrated')
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

  test('offers webhook/poll triggers with a nested platform and shows the subscription resource inline', async () => {
    const incomingHookApi = {
      catalog: vi.fn().mockResolvedValue([
        {
          sourceType: 'github',
          collectionModes: ['webhook', 'poll', 'hybrid'],
          resourceTypes: ['repository'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['continue_binding', 'create_issue'],
          nameKey: 'event_sources.github.name',
          descriptionKey: 'event_sources.github.description',
        },
        {
          sourceType: 'gitlab',
          collectionModes: ['webhook', 'poll', 'hybrid'],
          resourceTypes: ['project'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['continue_binding', 'create_issue'],
          nameKey: 'event_sources.gitlab.name',
          descriptionKey: 'event_sources.gitlab.description',
        },
        {
          sourceType: 'wework',
          collectionModes: ['internal'],
          resourceTypes: ['project_space'],
          eventTypes: ['task.created', 'task.status_changed'],
          executionTargets: ['existing_issue'],
          nameKey: 'event_sources.wework.name',
          descriptionKey: 'event_sources.wework.description',
        },
      ]),
      list: vi.fn().mockResolvedValue([
        {
          id: 'sub-1',
          projectId: '11',
          name: 'acme/app',
          status: 'active',
          sourceType: 'github',
          collectionMode: 'webhook',
          resource: {
            resourceType: 'repository',
            url: 'https://github.com/acme/app',
            displayName: 'acme/app',
          },
          webhookUrl: 'https://cloud.example/api/v1/incoming-hooks/sub-1',
          webhookSecret: null,
          pollIntervalSeconds: null,
          credentialRef: null,
          health: {},
          lastEventAt: null,
          nextPollAt: null,
          version: 1,
          createdAt: '2026-08-28T00:00:00Z',
          updatedAt: '2026-08-28T00:00:00Z',
        },
      ]),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>

    renderView({ incomingHookApi })
    await openRuleEditor()

    const triggerType = screen.getByTestId('automation-trigger-type')
    const optionValues = Array.from(triggerType.querySelectorAll('option')).map(
      option => option.value
    )
    expect(optionValues).toEqual(expect.arrayContaining(['schedule', 'wework', 'webhook', 'poll']))

    fireEvent.change(triggerType, {
      target: { value: 'webhook' },
    })

    await waitFor(() => expect(triggerType).toHaveValue('webhook'))
    expect(screen.getByTestId('automation-trigger-platform')).toHaveValue('github')
    await waitFor(() =>
      expect(screen.getByTestId('automation-event-subscription')).toHaveValue('sub-1')
    )
    expect(screen.getAllByText('acme/app').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('https://cloud.example/api/v1/incoming-hooks/sub-1').length
    ).toBeGreaterThan(0)
    expect(screen.getByTestId('automation-copy-webhook-url')).toBeInTheDocument()
    expect(screen.queryByTestId('automation-execution-target')).toBeNull()
    expect(
      screen
        .getByTestId('automation-target-branches')
        .compareDocumentPosition(screen.getByTestId('automation-event-subscription')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('filters subscriptions by the selected collection mode', async () => {
    const pollHook = {
      id: 'sub-2',
      projectId: '11',
      name: 'acme/app poll',
      status: 'active',
      sourceType: 'github',
      collectionMode: 'poll',
      resource: {
        resourceType: 'repository',
        url: 'https://github.com/acme/app',
        displayName: 'acme/app',
      },
      webhookUrl: null,
      webhookSecret: null,
      pollIntervalSeconds: 300,
      credentialRef: 'github',
      health: {},
      lastEventAt: null,
      nextPollAt: null,
      version: 1,
      createdAt: '2026-08-28T00:00:00Z',
      updatedAt: '2026-08-28T00:00:00Z',
    }
    const incomingHookApi = {
      catalog: vi.fn().mockResolvedValue([
        {
          sourceType: 'github',
          collectionModes: ['webhook', 'poll', 'hybrid'],
          resourceTypes: ['repository'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['continue_binding', 'create_issue'],
          nameKey: 'event_sources.github.name',
          descriptionKey: 'event_sources.github.description',
        },
        {
          sourceType: 'gitlab',
          collectionModes: ['webhook', 'poll', 'hybrid'],
          resourceTypes: ['project'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['continue_binding', 'create_issue'],
          nameKey: 'event_sources.gitlab.name',
          descriptionKey: 'event_sources.gitlab.description',
        },
        {
          sourceType: 'wework',
          collectionModes: ['internal'],
          resourceTypes: ['project_space'],
          eventTypes: ['task.created', 'task.status_changed'],
          executionTargets: ['existing_issue'],
          nameKey: 'event_sources.wework.name',
          descriptionKey: 'event_sources.wework.description',
        },
      ]),
      list: vi.fn().mockResolvedValue([
        {
          id: 'sub-1',
          projectId: '11',
          name: 'acme/app',
          status: 'active',
          sourceType: 'github',
          collectionMode: 'webhook',
          resource: {
            resourceType: 'repository',
            url: 'https://github.com/acme/app',
            displayName: 'acme/app',
          },
          webhookUrl: 'https://cloud.example/api/v1/incoming-hooks/sub-1',
          webhookSecret: null,
          pollIntervalSeconds: null,
          credentialRef: null,
          health: {},
          lastEventAt: null,
          nextPollAt: null,
          version: 1,
          createdAt: '2026-08-28T00:00:00Z',
          updatedAt: '2026-08-28T00:00:00Z',
        },
        pollHook,
      ]),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>

    renderView({ incomingHookApi })
    await openRuleEditor()

    fireEvent.change(screen.getByTestId('automation-trigger-type'), {
      target: { value: 'webhook' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('automation-event-subscription')).toHaveValue('sub-1')
    )

    fireEvent.change(screen.getByTestId('automation-trigger-type'), {
      target: { value: 'poll' },
    })
    await waitFor(() => expect(screen.getByTestId('automation-trigger-type')).toHaveValue('poll'))
    expect(screen.getByTestId('automation-trigger-platform')).toHaveValue('github')
    expect(screen.getByTestId('automation-trigger-poll-interval')).toHaveValue(5)
    fireEvent.change(screen.getByTestId('automation-trigger-poll-interval'), {
      target: { value: '7' },
    })
    expect(screen.getByTestId('automation-trigger-poll-interval')).toHaveValue(7)
    await waitFor(() =>
      expect(screen.getByTestId('automation-event-subscription')).toHaveValue('sub-2')
    )
  })

  test('configures a branch listener from upstream PR/MR deliveries without a project repository', async () => {
    const incomingHookApi = {
      catalog: vi.fn().mockResolvedValue([
        {
          sourceType: 'github',
          collectionModes: ['webhook', 'poll'],
          resourceTypes: ['repository'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['create_issue'],
          nameKey: 'event_sources.github.name',
          descriptionKey: 'event_sources.github.description',
        },
        {
          sourceType: 'gitlab',
          collectionModes: ['webhook', 'poll'],
          resourceTypes: ['project'],
          eventTypes: ['change_request.comment_created'],
          executionTargets: ['create_issue'],
          nameKey: 'event_sources.gitlab.name',
          descriptionKey: 'event_sources.gitlab.description',
        },
      ]),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>

    const { projectAutomationApi } = renderView({
      incomingHookApi,
      viewProject: {
        ...project,
        task_provider: 'local',
        provider_config: {},
      } as CloudProject,
    })
    await openRuleEditor()
    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))
    fireEvent.click(screen.getByTestId(`branch-node-main-${branchId}`))
    await waitFor(() =>
      expect(screen.getByTestId('branch-condition-event-0')).toHaveValue(
        'change_request.checks_failed'
      )
    )
    expect(screen.getByTestId('branch-condition-source-0')).toHaveValue('github')
    const handlerNode = screen
      .getAllByTestId(/^execution-node-step-/)
      .find(node => node.getAttribute('data-testid') !== 'execution-node-step-1')
    fireEvent.click(handlerNode!)
    fireEvent.change(screen.getByTestId(/^execution-node-name-/), {
      target: { value: '处理 MR 事件' },
    })
    fireEvent.click(screen.getByTestId(`branch-node-main-${branchId}`))
    expect(screen.queryByText(/当前项目未连接 GitHub\/GitLab 仓库/)).toBeNull()
    fireEvent.change(screen.getByTestId('branch-condition-source-0'), {
      target: { value: 'gitlab' },
    })
    expect(screen.getByTestId('branch-condition-source-0')).toHaveValue('gitlab')
    fireEvent.change(screen.getByTestId('branch-event-wait-mode'), {
      target: { value: 'webhook' },
    })
    fireEvent.change(screen.getByTestId('branch-condition-event-0'), {
      target: { value: 'change_request.comment_created' },
    })
    fireEvent.change(screen.getByTestId('branch-event-wait-mode'), {
      target: { value: 'poll' },
    })
    fireEvent.change(screen.getByTestId('branch-event-wait-poll-interval'), {
      target: { value: '7' },
    })
    fireEvent.click(screen.getByTestId('automation-editor-section-menu'))
    fireEvent.change(screen.getByLabelText('自动化名称'), {
      target: { value: '上游 MR 监听' },
    })
    fireEvent.click(screen.getByTestId('automation-save'))

    await waitFor(() => expect(projectAutomationApi.update).toHaveBeenCalled())
    const input = projectAutomationApi.update.mock.calls.at(-1)?.[2]
    const branch = input.eventConfig.runtime_workflow_definition.nodes.find(
      node => node.node_type === 'branch'
    )
    expect(branch.event_wait).toEqual({
      subject_source: 'upstream_pull_request',
      collection_mode: 'poll',
      poll_interval_seconds: 420,
    })
    expect(branch.branch_conditions[0].source_type).toBe('gitlab')
  })

  test('creates a subscription inline inside the trigger settings', async () => {
    let created = false
    const createdHook = {
      id: 'sub-new',
      projectId: '11',
      name: 'GitHub repository',
      status: 'active',
      sourceType: 'github',
      collectionMode: 'webhook',
      resource: {
        resourceType: 'repository',
        url: 'https://github.com/acme/app',
        displayName: 'acme/app',
      },
      webhookUrl: 'https://cloud.example/api/v1/incoming-hooks/sub-new',
      webhookSecret: 'signing-secret',
      pollIntervalSeconds: null,
      credentialRef: null,
      health: {},
      lastEventAt: null,
      nextPollAt: null,
      version: 1,
      createdAt: '2026-08-28T00:00:00Z',
      updatedAt: '2026-08-28T00:00:00Z',
    }
    const incomingHookApi = {
      catalog: vi.fn().mockResolvedValue([
        {
          sourceType: 'github',
          collectionModes: ['webhook'],
          resourceTypes: ['repository'],
          eventTypes: ['change_request.checks_failed'],
          executionTargets: ['continue_binding'],
          nameKey: 'event_sources.github.name',
          descriptionKey: 'event_sources.github.description',
        },
        {
          sourceType: 'wework',
          collectionModes: ['internal'],
          resourceTypes: ['project_space'],
          eventTypes: ['task.created', 'task.status_changed'],
          executionTargets: ['existing_issue'],
          nameKey: 'event_sources.wework.name',
          descriptionKey: 'event_sources.wework.description',
        },
      ]),
      list: vi.fn().mockImplementation(() => Promise.resolve(created ? [createdHook] : [])),
      create: vi.fn().mockImplementation(() => {
        created = true
        return Promise.resolve(createdHook)
      }),
      update: vi.fn(),
      rotate: vi.fn(),
      listEvents: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>

    renderView({ incomingHookApi })
    await openRuleEditor()

    fireEvent.change(screen.getByTestId('automation-trigger-type'), {
      target: { value: 'webhook' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('automation-trigger-type')).toHaveValue('webhook')
    )
    await waitFor(() =>
      expect(screen.getByTestId('automation-trigger-platform')).toHaveValue('github')
    )

    fireEvent.click(screen.getByTestId('automation-create-subscription'))
    fireEvent.change(screen.getByTestId('event-subscription-name'), {
      target: { value: 'GitHub repository' },
    })
    fireEvent.change(screen.getByTestId('event-subscription-resource-url'), {
      target: { value: 'https://github.com/acme/app' },
    })
    fireEvent.click(screen.getByTestId('event-subscription-save'))

    await waitFor(() =>
      expect(screen.getByTestId('automation-event-subscription')).toHaveValue('sub-new')
    )
    expect(incomingHookApi.create).toHaveBeenCalledWith('11', {
      name: 'GitHub repository',
      sourceType: 'github',
      collectionMode: 'webhook',
      resource: {
        url: 'https://github.com/acme/app',
      },
      pollIntervalSeconds: null,
      credentialRef: null,
    })
    expect(
      screen.getAllByText('https://cloud.example/api/v1/incoming-hooks/sub-new').length
    ).toBeGreaterThan(0)
  })

  test('keeps unsaved edits when a background rules refresh lands while editing', async () => {
    const uiRule = automationRuleFromBackend(rule)
    const view = render(
      <AutomationRulesView
        rules={[uiRule]}
        runs={[]}
        eventSourceCatalog={[]}
        projectId="11"
        canManage
      />
    )

    fireEvent.click(await screen.findByTestId('automation-card-rule-1'))

    // The exact reported scenario: a brand-new execution node is added while
    // the editor is open and it has not been saved yet.
    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-task-step-1'))
    expect(screen.getAllByTestId(/^execution-node-step-/)).toHaveLength(3)

    // A background automations refresh replaces the rule in the list with the
    // server copy, which has no trace of the unsaved node.
    view.rerender(
      <AutomationRulesView
        rules={[automationRuleFromBackend({ ...rule, name: '服务端旧名称' })]}
        runs={[]}
        eventSourceCatalog={[]}
        projectId="11"
        canManage
      />
    )

    // The new node must not disappear, and the restored server name must not
    // clobber the in-progress draft.
    await waitFor(() => expect(screen.getAllByTestId(/^execution-node-step-/)).toHaveLength(3))
    expect(screen.queryByText('服务端旧名称')).not.toBeInTheDocument()
  })

  test('removes an empty branch condition when its handler node is deleted', async () => {
    renderView()
    await openRuleEditor()

    fireEvent.click(screen.getByTestId('automation-node-insert-after-step-1'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-branch-step-1'))

    const branchNode = await screen.findByTestId(/^branch-node-branch-/)
    const branchId = branchNode.getAttribute('data-testid').replace('branch-node-', '')
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-${branchId}`))
    fireEvent.click(screen.getByTestId(`automation-node-insert-after-task-${branchId}`))

    const handlerNode = screen
      .getAllByTestId(/^execution-node-step-/)
      .find(node => node.getAttribute('data-testid') !== 'execution-node-step-1')
    expect(handlerNode).toBeDefined()
    fireEvent.click(handlerNode!)
    const handlerDelete = await screen.findByTestId(/^execution-node-delete-step-/)
    fireEvent.click(handlerDelete)

    expect(screen.queryByText('分支 1')).not.toBeInTheDocument()
    expect(screen.getByTestId(`branch-node-${branchId}`)).toBeInTheDocument()
  })
})
