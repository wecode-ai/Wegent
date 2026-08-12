import type {
  ExecutionActorRef,
  RepositoryBinding,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowStageGroup,
} from '@/api/projectWorkflows'

export interface ActorChoice {
  value: string
  label: string
  actor: ExecutionActorRef
}

export interface SquadDraft {
  name: string
  leaderAgentId: string
  memberAgentIds: string[]
  routingInstructions: string
  maxParallelMembers: number
}

export interface RepositoryDraft {
  provider: RepositoryBinding['provider']
  repositoryIdentity: string
  repositoryUrl: string
  defaultBranch: string
  credentialRef: string
  branchPattern: string
  pullRequestBase: string
  autoCreatePullRequest: boolean
  autoMerge: boolean
  mergeStrategy: string
}

export interface WorkflowDraft {
  name: string
  description: string
  repositoryBindingId: string
  triggerMode: WorkflowDefinition['triggerMode']
  failurePolicy: WorkflowDefinition['failurePolicy']
  isDefault: boolean
  stages: WorkflowStageGroup[]
}

export function emptySquadDraft(): SquadDraft {
  return {
    name: '',
    leaderAgentId: '',
    memberAgentIds: [],
    routingInstructions: '',
    maxParallelMembers: 2,
  }
}

export function emptyRepositoryDraft(): RepositoryDraft {
  return {
    provider: 'github',
    repositoryIdentity: '',
    repositoryUrl: '',
    defaultBranch: 'main',
    credentialRef: '',
    branchPattern: 'feature/{task_key}-{slug}',
    pullRequestBase: 'main',
    autoCreatePullRequest: true,
    autoMerge: false,
    mergeStrategy: 'squash',
  }
}

export function emptyWorkflowDraft(): WorkflowDraft {
  return {
    name: '',
    description: '',
    repositoryBindingId: '',
    triggerMode: 'manual',
    failurePolicy: 'pause',
    isDefault: false,
    stages: [],
  }
}

export function actorValue(actor: ExecutionActorRef | undefined): string {
  if (!actor) return ''
  return actor.type === 'wegent_team' ? `wegent_team:${actor.teamId}` : `${actor.type}:${actor.id}`
}

export function emptyNode(index: number, actor?: ExecutionActorRef): WorkflowNode {
  return {
    key: `step-${index}`,
    name: `Step ${index}`,
    type: 'agent',
    actor,
    promptTemplate: '',
    inputArtifacts: [],
    requiredOutputs: ['execution_result'],
    workspaceMode: 'git_worktree',
    maxRetries: 1,
    timeoutSeconds: 3600,
  }
}

export function defaultStages(actor?: ExecutionActorRef): WorkflowStageGroup[] {
  const agentNode = (
    key: string,
    name: string,
    requiredOutputs: string[],
    promptTemplate: string
  ): WorkflowNode => ({
    key,
    name,
    type: 'agent',
    actor,
    promptTemplate,
    inputArtifacts: [],
    requiredOutputs,
    workspaceMode: 'git_worktree',
    maxRetries: 1,
    timeoutSeconds: 3600,
  })
  return [
    {
      key: 'analysis',
      name: '需求分析',
      execution: 'serial',
      completion: 'all',
      nodes: [
        agentNode(
          'requirements',
          '分析需求与验收标准',
          ['requirements_analysis', 'implementation_plan'],
          '分析任务上下文，输出结构化需求、实施计划和可验证的验收标准。'
        ),
      ],
    },
    {
      key: 'implementation',
      name: '开发',
      execution: 'serial',
      completion: 'all',
      nodes: [
        agentNode(
          'develop',
          '修改代码并提交',
          ['code_change_summary', 'pull_request'],
          '按照实施计划修改代码、运行聚焦测试并创建或更新 Pull Request。'
        ),
      ],
    },
    {
      key: 'verification',
      name: '测试与 Review',
      execution: 'parallel',
      completion: 'all',
      nodes: [
        agentNode(
          'test',
          '运行测试',
          ['test_report'],
          '执行真实测试命令，提交包含命令、通过、失败、跳过和日志位置的测试报告。'
        ),
        agentNode(
          'review',
          '代码审查',
          ['review_report'],
          '结合需求、Diff、测试和仓库规则审查代码，输出阻塞问题与审批建议。'
        ),
      ],
    },
    {
      key: 'gates',
      name: '审批与合并',
      execution: 'serial',
      completion: 'all',
      nodes: [
        {
          ...emptyNode(1),
          key: 'human-approval',
          name: '人工批准',
          type: 'human_gate',
          actor: undefined,
          requiredOutputs: [],
          condition: 'human_approved',
        },
        {
          ...emptyNode(2),
          key: 'ci',
          name: 'CI 通过',
          type: 'ci_gate',
          actor: undefined,
          requiredOutputs: [],
          condition: 'ci_passed',
        },
        {
          ...emptyNode(3),
          key: 'merge',
          name: '合并 Pull Request',
          type: 'merge',
          actor: undefined,
          requiredOutputs: [],
          condition: 'pr_merged',
        },
        {
          ...emptyNode(4),
          key: 'complete',
          name: '完成任务',
          type: 'complete',
          actor: undefined,
          requiredOutputs: [],
          condition: undefined,
        },
      ],
    },
  ]
}
