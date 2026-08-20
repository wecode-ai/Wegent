import { describe, expect, it } from 'vitest'
import {
  attachIssueWorkflowDelivery,
  decideIssueWorkflowNode,
  instantiateIssueWorkflow,
  preferNewestLoopItemSnapshot,
  reconcileIssueWorkflowForTaskBindings,
  updateIssueWorkflowForRuntime,
  workflowBoardStatus,
} from '@/api/issueWorkflow'
import type {
  CloudLoopItem,
  IssueWorkflowInstance,
  ProjectWorkflowDefinition,
} from '@/api/deliveries'

const definition = {
  version: 3,
  nodes: [
    {
      id: 'develop',
      name: '开发',
      kind: 'my_task' as const,
      depends_on: [],
      required: true,
      workspace_policy: 'composer' as const,
    },
    {
      id: 'test',
      name: '测试',
      kind: 'my_task' as const,
      depends_on: ['develop'],
      required: true,
      workspace_policy: 'inherit' as const,
    },
    {
      id: 'pr',
      name: '提 PR',
      kind: 'my_task' as const,
      depends_on: ['test'],
      required: true,
      workspace_policy: 'inherit' as const,
    },
  ],
}

const endpointDefinition = {
  version: 1,
  stage_mode: 'dag' as const,
  advancement_policy: 'manual' as const,
  nodes: [
    {
      id: 'develop',
      name: '开发',
      depends_on: [],
      required: true,
      workspace_policy: 'composer' as const,
    },
    {
      id: 'wait',
      name: '等待',
      node_type: 'wait' as const,
      depends_on: ['develop'],
      required: true,
      workspace_policy: 'none' as const,
      wait_config: {
        rules: [
          {
            id: 'rule-1',
            event_type: 'merged',
            mode: 'trigger' as const,
            action: 'complete' as const,
            rerun_prompt: '',
          },
        ],
      },
    },
  ],
}

describe('Issue workflow projection', () => {
  it('instantiates only root nodes as ready', () => {
    expect(instantiateIssueWorkflow(definition)?.nodes.map(node => node.status)).toEqual([
      'ready',
      'blocked',
      'blocked',
    ])
  })

  it('does not let a delayed queued snapshot overwrite a completed workflow', () => {
    const queued = {
      id: 'ISSUE-1',
      version: 3,
      workflow: {
        version: 3,
        definition_version: 1,
        nodes: [],
      },
    } as CloudLoopItem
    const completed = {
      ...queued,
      version: 5,
      workflow: {
        ...queued.workflow!,
        version: 5,
      },
    }

    expect(preferNewestLoopItemSnapshot(completed, queued)).toBe(completed)
    expect(preferNewestLoopItemSnapshot(queued, completed)).toBe(completed)
  })

  it('waits for human approval before releasing successors', () => {
    let workflow = instantiateIssueWorkflow(definition)!
    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'running')
    expect(workflowBoardStatus(workflow)).toBe('in_progress')

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded')
    expect(workflow.nodes.map(node => node.status)).toEqual([
      'awaiting_approval',
      'blocked',
      'blocked',
    ])
    workflow = decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')
    expect(workflow.nodes.map(node => node.status)).toEqual(['completed', 'ready', 'blocked'])
    expect(workflowBoardStatus(workflow)).toBe('pending')

    workflow = updateIssueWorkflowForRuntime(workflow, 'test', 'succeeded')
    workflow = decideIssueWorkflowNode(workflow, 'test', 'approve', 1, '')
    workflow = updateIssueWorkflowForRuntime(workflow, 'pr', 'succeeded')
    workflow = decideIssueWorkflowNode(workflow, 'pr', 'approve', 1, '')
    expect(workflowBoardStatus(workflow)).toBe('in_review')
  })

  it('marks the root stage ready and activates the wait node', () => {
    const workflow = instantiateIssueWorkflow(endpointDefinition)!

    expect(workflow.nodes.map(node => [node.id, node.status])).toEqual([
      ['develop', 'ready'],
      ['wait', 'waiting'],
    ])
    expect(workflowBoardStatus(workflow)).toBe('in_progress')
  })

  it('keeps the wait node active while the stage runs and completes it after approval', () => {
    let workflow = instantiateIssueWorkflow(endpointDefinition)!
    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'running')
    expect(workflow.nodes.map(node => [node.id, node.status])).toEqual([
      ['develop', 'running'],
      ['wait', 'waiting'],
    ])
    expect(workflowBoardStatus(workflow)).toBe('in_progress')

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded')
    workflow = decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')
    expect(workflow.nodes.map(node => [node.id, node.status])).toEqual([
      ['develop', 'completed'],
      ['wait', 'waiting'],
    ])
    expect(workflowBoardStatus(workflow)).toBe('in_progress')
  })

  it('moves the issue to review when the last required stage finishes', () => {
    let workflow = instantiateIssueWorkflow(definition)!
    for (const stage of ['develop', 'test', 'pr']) {
      workflow = updateIssueWorkflowForRuntime(workflow, stage, 'succeeded')
      workflow = decideIssueWorkflowNode(workflow, stage, 'approve', 1, '')
    }

    expect(workflow.nodes.map(node => node.status)).toEqual(['completed', 'completed', 'completed'])
    expect(workflowBoardStatus(workflow)).toBe('in_review')
  })

  it('strips legacy start and end sentinels when instantiating', () => {
    const workflow = instantiateIssueWorkflow({
      version: 1,
      stage_mode: 'dag',
      advancement_policy: 'manual',
      nodes: [
        {
          id: 'start',
          name: '开始',
          node_type: 'start' as const,
          depends_on: [],
          required: false,
          workspace_policy: 'none',
        },
        {
          id: 'develop',
          name: '开发',
          depends_on: ['start'],
          required: true,
          workspace_policy: 'composer',
        },
        {
          id: 'end',
          name: '结束',
          node_type: 'end' as const,
          depends_on: ['develop'],
          required: true,
          workspace_policy: 'none',
        },
      ],
    } as unknown as ProjectWorkflowDefinition)!

    expect(workflow.nodes.map(node => [node.id, node.status])).toEqual([['develop', 'ready']])
    expect(workflowBoardStatus(workflow)).toBe('pending')
  })

  it('strips legacy sentinels from snapshots during reconciliation', () => {
    const workflow = {
      version: 1,
      definition_version: 1,
      stage_mode: 'dag',
      advancement_policy: 'manual',
      nodes: [
        {
          id: 'start',
          name: '开始',
          node_type: 'start' as const,
          status: 'completed',
        },
        {
          id: 'develop',
          name: '开发',
          depends_on: ['start'],
          status: 'ready',
        },
        {
          id: 'end',
          name: '结束',
          node_type: 'end' as const,
          depends_on: ['develop'],
          status: 'blocked',
        },
      ],
    } as unknown as IssueWorkflowInstance

    const reconciled = reconcileIssueWorkflowForTaskBindings(workflow, [])
    expect(reconciled.nodes.map(node => node.id)).toEqual(['develop'])
  })

  it('requires configured deliverables before approval', () => {
    const withDeliverables = {
      ...definition,
      nodes: definition.nodes.map(node =>
        node.id === 'develop'
          ? {
              ...node,
              required_deliverables: [
                {
                  id: 'test-report',
                  name: '测试报告',
                  description: '',
                  value_type: 'file' as const,
                  file_constraints: {
                    accepted_types: [],
                    min_files: 1,
                    max_files: 1,
                  },
                },
              ],
            }
          : node
      ),
    }
    let workflow = instantiateIssueWorkflow(withDeliverables)!
    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded')
    expect(() => decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')).toThrow(
      'Required deliverables are missing'
    )
    workflow = attachIssueWorkflowDelivery(workflow, 'develop', 'delivery-1', ['test-report'])
    workflow = decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')
    expect(workflow.nodes[0].status).toBe('completed')
  })

  it('uses the latest bound task terminal state while preserving older task history', () => {
    let workflow = instantiateIssueWorkflow(definition)!
    const olderTask = 'device:task-1'
    const latestTask = 'device:task-2'

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'failed', olderTask, [olderTask])
    expect(workflow.nodes[0].status).toBe('failed')

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'running', latestTask, [
      latestTask,
      olderTask,
    ])
    expect(workflow.nodes[0].status).toBe('running')

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded', latestTask, [
      latestTask,
      olderTask,
    ])
    expect(workflow.nodes[0]).toMatchObject({
      status: 'awaiting_approval',
      task_statuses: {
        [olderTask]: 'failed',
        [latestTask]: 'succeeded',
      },
    })

    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'failed', olderTask, [
      latestTask,
      olderTask,
    ])
    expect(workflow.nodes[0].status).toBe('awaiting_approval')
  })

  it('repairs a stale failed stage from the latest bound task truth', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      status: 'failed',
      task_ids: ['device:task-1', 'device:task-2'],
      task_statuses: {
        'device:task-1': 'failed',
        'device:task-2': 'succeeded',
      },
    }

    const reconciled = reconcileIssueWorkflowForTaskBindings(workflow, [
      {
        device_id: 'device',
        task_id: 'task-1',
        workflow_node_id: 'develop',
        linked_at: '2026-08-18T10:00:00Z',
      },
      {
        device_id: 'device',
        task_id: 'task-2',
        workflow_node_id: 'develop',
        linked_at: '2026-08-18T11:00:00Z',
      },
    ])

    expect(reconciled.nodes[0]).toMatchObject({
      status: 'awaiting_approval',
      task_ids: ['device:task-2', 'device:task-1'],
    })
  })

  it('preserves the canonical stage state when the newest binding has no runtime status', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      status: 'changes_requested',
      task_ids: ['device:old-task'],
      task_statuses: { 'device:old-task': 'succeeded' },
    }

    const reconciled = reconcileIssueWorkflowForTaskBindings(workflow, [
      {
        device_id: 'device',
        task_id: 'new-task',
        workflow_node_id: 'develop',
        linked_at: '2026-08-19T10:00:00Z',
      },
      {
        device_id: 'device',
        task_id: 'old-task',
        workflow_node_id: 'develop',
        linked_at: '2026-08-19T09:00:00Z',
      },
    ])

    expect(reconciled.nodes[0]).toMatchObject({
      status: 'changes_requested',
      task_ids: ['device:new-task', 'device:old-task'],
    })
  })
})
