import { describe, expect, it } from 'vitest'
import {
  attachIssueWorkflowDelivery,
  decideIssueWorkflowNode,
  instantiateIssueWorkflow,
  preferNewestLoopItemSnapshot,
  updateIssueWorkflowForRuntime,
  workflowBoardStatus,
} from '@/api/issueWorkflow'
import type { CloudLoopItem } from '@/api/deliveries'

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
        node.id === 'develop' ? { ...node, required_deliverables: ['测试报告'] } : node
      ),
    }
    let workflow = instantiateIssueWorkflow(withDeliverables)!
    workflow = updateIssueWorkflowForRuntime(workflow, 'develop', 'succeeded')
    expect(() => decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')).toThrow(
      'Required deliverables are missing'
    )
    workflow = attachIssueWorkflowDelivery(workflow, 'develop', 'delivery-1')
    workflow = decideIssueWorkflowNode(workflow, 'develop', 'approve', 1, '')
    expect(workflow.nodes[0].status).toBe('completed')
  })
})
