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
import type { CloudLoopItem } from '@/api/deliveries'

const loopDefinition = {
  version: 3,
  nodes: [
    {
      id: 'start',
      name: '开始',
      node_type: 'event' as const,
      role: 'start' as const,
      depends_on: [],
      required: false,
      workspace_policy: 'none' as const,
    },
    {
      id: 'loop1',
      name: '修复循环',
      node_type: 'loop' as const,
      depends_on: ['start'],
      body_node_ids: ['ls', 'br', 'fix1', 'le'],
      loop_config: { max_attempts: 5, timeout_seconds: null },
      required: true,
      workspace_policy: 'composer' as const,
    },
    {
      id: 'after',
      name: '发布',
      depends_on: ['loop1'],
      required: true,
      workspace_policy: 'composer' as const,
    },
    {
      id: 'ls',
      name: '循环开始',
      node_type: 'loop_start' as const,
      loop_id: 'loop1',
      depends_on: [],
      required: false,
      workspace_policy: 'none' as const,
    },
    {
      id: 'br',
      name: '分支',
      node_type: 'branch' as const,
      loop_id: 'loop1',
      depends_on: ['ls'],
      branch_conditions: [
        { event_type: 'change_request.checks_failed', handler_node_ids: ['fix1'] },
        { event_type: 'change_request.merged', handler_node_ids: ['le'] },
      ],
      required: false,
      workspace_policy: 'none' as const,
    },
    {
      id: 'fix1',
      name: '修复',
      node_type: 'task' as const,
      loop_id: 'loop1',
      depends_on: ['br'],
      automation_rule_id: 'fix-rule',
      execution_mode: 'robot' as const,
      required: false,
      workspace_policy: 'composer' as const,
    },
    {
      id: 'le',
      name: '循环结束',
      node_type: 'loop_end' as const,
      loop_id: 'loop1',
      depends_on: ['br'],
      required: false,
      workspace_policy: 'none' as const,
    },
  ],
}

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

describe('Issue workflow projection', () => {
  it('instantiates only root nodes as ready', () => {
    expect(instantiateIssueWorkflow(definition)?.nodes.map(node => node.status)).toEqual([
      'ready',
      'blocked',
      'blocked',
    ])
  })

  it('instantiates a loop with an armed waiting branch', () => {
    const instance = instantiateIssueWorkflow(loopDefinition)
    const byId = new Map(instance?.nodes.map(node => [node.id, node]))
    expect(byId.get('start')?.status).toBe('completed')
    expect(byId.get('loop1')?.loop_state).toBe('idle')
    expect(byId.get('br')?.status).toBe('blocked')
    expect(byId.get('fix1')?.status).toBe('blocked')
    expect(byId.get('after')?.status).toBe('blocked')
  })

  it('keeps loop body nodes blocked when their dependencies complete', () => {
    const instance = instantiateIssueWorkflow(loopDefinition)
    if (!instance) throw new Error('instance expected')
    const advanced = updateIssueWorkflowForRuntime(instance, 'start', 'succeeded')
    const byId = new Map(advanced.nodes.map(node => [node.id, node]))
    expect(byId.get('br')?.status).toBe('blocked')
    expect(byId.get('fix1')?.status).toBe('blocked')
    expect(byId.get('after')?.status).toBe('blocked')
  })

  it('projects waiting and reacting loops as in progress', () => {
    const instance = instantiateIssueWorkflow(loopDefinition)
    if (!instance) throw new Error('instance expected')
    const waiting = {
      ...instance,
      nodes: instance.nodes.map(node =>
        node.id === 'br' ? { ...node, status: 'waiting' as const } : node
      ),
    }
    expect(workflowBoardStatus(waiting)).toBe('in_progress')
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

describe('workflow execution authority', () => {
  it('projects explicit AI stages without an automation rule through deliverable completion', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.nodes[0].execution_mode = 'robot'
    workflow.nodes[0].required_deliverables = [
      { id: 'report', name: 'Report', description: '', value_type: 'file' },
    ]
    const succeeded = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded', 'device:task')
    expect(succeeded.nodes[0].status).toBe('awaiting_deliverables')
    const delivered = attachIssueWorkflowDelivery(succeeded, 'develop', 'delivery', ['report'])
    expect(delivered.nodes[0].status).toBe('completed')
    expect(delivered.nodes[1].status).toBe('ready')
  })

  it('honors explicit human execution even when a rule is referenced', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.nodes[0].execution_mode = 'human'
    workflow.nodes[0].automation_rule_id = 'rule'
    const succeeded = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded')
    expect(succeeded.nodes[0].status).toBe('awaiting_approval')
    expect(decideIssueWorkflowNode(succeeded, 'develop', 'approve', 1, '').nodes[0].status).toBe(
      'completed'
    )
  })

  it.each(['approve', 'reject', 'force_advance'] as const)(
    'rejects %s for an AI stage without a rule',
    action => {
      const workflow = instantiateIssueWorkflow(definition)!
      workflow.nodes[0].execution_mode = 'robot'
      workflow.nodes[0].status = 'awaiting_approval'
      expect(() => decideIssueWorkflowNode(workflow, 'develop', action, 1, 'reason')).toThrow(
        'Automated stages do not accept decisions'
      )
    }
  )

  it.each(['paused', 'running', 'waiting_human', 'completed'] as const)(
    'updates AI work results without changing orchestration while %s',
    status => {
      let workflow = instantiateIssueWorkflow(definition)!
      workflow.advancement_policy = 'ai'
      workflow.orchestration_status = status
      workflow.nodes[0].status = 'failed'
      workflow.nodes[0].execution_mode = 'robot'
      workflow.nodes[0].execution_error = 'cancelled'
      workflow.nodes[0].task_ids = ['device:task']
      workflow.nodes[0].task_statuses = { 'device:task': 'succeeded' }
      const displayed = reconcileIssueWorkflowForTaskBindings(workflow, [])
      expect(displayed.nodes[0]).toMatchObject({ status: 'completed', execution_error: null })
      expect(displayed.orchestration_status).toBe(status)
      for (const [runtimeStatus, nodeStatus] of [
        ['running', 'running'],
        ['succeeded', 'completed'],
        ['running', 'running'],
        ['failed', 'failed'],
        ['succeeded', 'completed'],
      ] as const) {
        workflow = updateIssueWorkflowForRuntime(workflow, 'develop', runtimeStatus, 'device:task')
        expect(workflow.orchestration_status).toBe(status)
        expect(workflow.nodes[0].status).toBe(nodeStatus)
        expect(workflow.nodes[0].execution_error).toBeNull()
        expect(workflow.nodes[0].task_statuses?.['device:task']).toBe(runtimeStatus)
        expect(workflow.nodes[1].status).toBe('blocked')
      }
    }
  )

  it.each(['dispatching', 'waiting_human'])(
    'preserves the current %s assignment while another task completes',
    status => {
      const workflow = instantiateIssueWorkflow(definition)!
      workflow.advancement_policy = 'ai'
      workflow.nodes[0].execution_mode = 'robot'
      workflow.assignment = {
        id: 'assignment',
        node_id: 'develop',
        assignee_user_id: 1,
        status,
        result: null,
        decision: { reason: '', instruction: '' },
      }
      const updated = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded', 'device:task')
      expect(updated.nodes[0].status).toBe(workflow.nodes[0].status)
      expect(updated.assignment).toEqual(workflow.assignment)
    }
  )

  it('uses the newest bound task instead of an older running task', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.advancement_policy = 'ai'
    workflow.orchestration_status = 'paused'
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      execution_mode: 'robot',
      status: 'failed',
      execution_error: 'cancelled',
      task_ids: ['device:old', 'device:new'],
      task_statuses: { 'device:old': 'running', 'device:new': 'succeeded' },
    }
    const displayed = reconcileIssueWorkflowForTaskBindings(workflow, [
      { id: 1, device_id: 'device', task_id: 'old', workflow_node_id: 'develop' },
      { id: 2, device_id: 'device', task_id: 'new', workflow_node_id: 'develop' },
    ])
    expect(displayed.nodes[0]).toMatchObject({
      status: 'completed',
      execution_error: null,
      task_ids: ['device:new', 'device:old'],
    })
    expect(displayed.orchestration_status).toBe('paused')
    expect(displayed.nodes[1].status).toBe('blocked')
  })

  it('does not mistake a human stage task result for human approval', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.advancement_policy = 'ai'
    workflow.nodes[0].execution_mode = 'human'
    workflow.nodes[0].status = 'running'
    expect(
      updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded', 'device:task').nodes[0].status
    ).toBe('running')
  })

  it('does not advance paused sequential stages from task results', () => {
    const workflow = instantiateIssueWorkflow(definition)!
    workflow.orchestration_status = 'paused'
    workflow.nodes[0].status = 'failed'
    const updated = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded', 'device:task')
    expect(reconcileIssueWorkflowForTaskBindings(updated, []).nodes[0].status).toBe('failed')
    expect(updated.nodes[1].status).toBe('blocked')
  })
})
