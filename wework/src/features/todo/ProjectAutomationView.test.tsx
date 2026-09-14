import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import {
  AutomationPolicyView,
  AutomationUiHostProvider,
  type AutomationRulesViewProps,
} from '@wegent/collaboration/automation-ui'
import type { AutomationUiRule } from '@wegent/collaboration/automation'

function policyRule(overrides: Partial<AutomationUiRule> = {}): AutomationUiRule {
  return {
    id: 'policy-1',
    persisted: true,
    origin: 'automation',
    version: 2,
    name: 'Issue 智能调度',
    description: '',
    enabled: true,
    updatedAt: '2026-09-13T10:00:00+08:00',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: 'event',
      source: 'wework',
      collectionMode: 'internal',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '09:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        id: 'coordinator-1',
        name: '项目经理智能体',
        prompt: '先理解目标，再拆分并分配可独立验证的任务。',
        kind: 'dynamic',
        dependencies: [],
        dependencyContext: {},
        x: 0,
        y: 0,
        deliverables: [],
        executionMode: 'automatic',
        environment: '',
        executionEnvironment: 'local',
        executionDeviceId: null,
        runtimeProfileId: null,
        model: '',
        modelType: null,
        modelOptions: {},
        plugins: [],
        projectPlugins: [],
        workspacePolicy: 'composer',
        required: true,
        automationRuleId: null,
        executionConfig: null,
        executionConfigOverride: false,
        approvalPolicy: 'required',
        nodeType: 'task',
        role: null,
        loopId: null,
        bodyNodeIds: [],
        loopConfig: null,
        branchConditions: [],
        eventWait: null,
        subgraph: { nodes: [] },
      },
    ],
    legacyDefinition: null,
    runtimeSource: 'runtime_user',
    ...overrides,
  }
}

function renderPolicy(props: Partial<AutomationRulesViewProps> = {}) {
  return render(
    <AutomationUiHostProvider
      host={{
        useTranslation: () => ({ t: (key: string) => key }),
        PopupMenu: ({ children }) => children,
        Tooltip: ({ children }) => children,
        EventSubscriptionPicker: () => null,
      }}
      locale="zh-CN"
    >
      <AutomationPolicyView rules={[policyRule()]} runs={[]} {...props} />
    </AutomationUiHostProvider>
  )
}

describe('project automation policy', () => {
  test('presents dispatch as an explicit policy instead of a canvas', () => {
    renderPolicy()

    expect(screen.getByTestId('project-automation-policy')).toBeVisible()
    expect(screen.getByText('什么时候开始调度？')).toBeVisible()
    expect(screen.getByText('项目经理智能体如何协调？')).toBeVisible()
    expect(screen.getByText('流程步骤')).toBeVisible()
    expect(screen.getByText('无需预设步骤')).toBeVisible()
    expect(screen.queryByText('编排')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automation-canvas-fit-view')).not.toBeInTheDocument()
  })

  test('saves trigger, prompt, and approval changes only after explicit confirmation', async () => {
    const onSaveRule = vi.fn(async (rule: AutomationUiRule) => ({
      ...rule,
      version: rule.version + 1,
    }))
    renderPolicy({ onSaveRule })

    fireEvent.click(screen.getByTestId('automation-trigger-started'))
    fireEvent.change(screen.getByTestId('automation-coordinator-prompt'), {
      target: { value: '先确认验收标准，再根据成员能力与负载分配任务。' },
    })
    fireEvent.click(screen.getByTestId('automation-approval-automatic'))

    expect(onSaveRule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('automation-save-policy'))

    await waitFor(() => expect(onSaveRule).toHaveBeenCalledTimes(1))
    const saved = onSaveRule.mock.calls[0]?.[0]
    expect(saved?.trigger.startMode).toBe('status')
    expect(saved?.steps[0]?.prompt).toBe('先确认验收标准，再根据成员能力与负载分配任务。')
    expect(saved?.steps[0]?.approvalPolicy).toBe('automatic')
  })

  test('shows fixed workflow nodes as a readable ordered list', () => {
    const fixedRule = policyRule({
      steps: [
        {
          ...policyRule().steps[0]!,
          id: 'step-1',
          name: '分析需求',
          prompt: '明确目标和验收标准',
          kind: 'task',
          subgraph: null,
        },
        {
          ...policyRule().steps[0]!,
          id: 'step-2',
          name: '实现与验证',
          prompt: '完成修改并提供测试证据',
          kind: 'task',
          subgraph: null,
        },
      ],
    })
    renderPolicy({ rules: [fixedRule] })

    expect(screen.getByText('这是一条固定执行流程')).toBeVisible()
    expect(screen.getByText('分析需求')).toBeVisible()
    expect(screen.getByText('实现与验证')).toBeVisible()
  })

  test('opens run history and keeps the Issue as the execution anchor', async () => {
    renderPolicy({
      runs: [
        {
          id: 'run-1',
          ruleId: 'policy-1',
          ruleName: 'Issue 智能调度',
          issue: 'WEWORK-554 项目自动化交互优化',
          status: 'succeeded',
          triggeredAt: '2026-09-13T10:00:00+08:00',
          startedAt: '2026-09-13T10:00:01+08:00',
          duration: '3m',
        },
      ],
      onLoadRuns: vi.fn(async () => []),
    })

    fireEvent.click(screen.getByTestId('automation-open-runs'))

    expect(await screen.findByTestId('automation-run-history')).toBeVisible()
    expect(screen.getByText('WEWORK-554 项目自动化交互优化')).toBeVisible()
    expect(screen.getByText(/对应 Issue 查看分配/)).toBeVisible()
  })
})
