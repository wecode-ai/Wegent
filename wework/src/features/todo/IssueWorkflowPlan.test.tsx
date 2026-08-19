import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { CloudLoopItem, WorkflowPlan } from '@/api/deliveries'
import { IssueWorkflowPlan } from './IssueWorkflowPlan'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const item = {
  id: 'ISSUE-1',
  workflow: {
    orchestration_status: 'planning',
    active_run_id: 'workflow-1',
    nodes: [],
  },
} as CloudLoopItem

const plan: WorkflowPlan = {
  run_id: 'workflow-1',
  issue_id: item.id,
  stage_id: '__issue__',
  plan_version: 1,
  approval_policy: 'required',
  status: 'planning',
  summary: '',
  items: [],
  coordinator_run: {
    workflow_run_id: 'workflow-1',
    automation_run_id: 'automation-1',
    plan_version: 1,
    stage_id: '__issue__',
    manager_type: 'custom',
    manager_name: '调度模型',
    model: 'ali-deepseek-v4-flash',
    execution_environment: 'cloud',
    execution_device_id: 'cloud-device-dev',
    execution_id: 7,
    runtime_device_id: null,
    runtime_task_id: null,
    backend_task_id: null,
    activity_message_id: 'message-1',
    status: 'queued',
    last_activity_at: '2026-08-19T08:24:05Z',
    started_at: null,
    completed_at: null,
    error: null,
  },
}

describe('IssueWorkflowPlan', () => {
  test('shows the real coordinator target and opens its activity', async () => {
    const onViewActivity = vi.fn()
    const api = {
      getWorkflowPlan: vi.fn().mockResolvedValue(plan),
      getLoopItem: vi.fn().mockResolvedValue(item),
      replanWorkflowPlan: vi.fn(),
    }

    render(
      <IssueWorkflowPlan
        api={api as never}
        item={item}
        onUpdated={vi.fn()}
        onViewActivity={onViewActivity}
      />
    )

    expect(await screen.findByTestId('issue-workflow-coordinator-run')).toHaveTextContent(
      'ali-deepseek-v4-flash'
    )
    expect(screen.getByTestId('issue-workflow-coordinator-run')).toHaveTextContent(
      'cloud-device-dev'
    )
    expect(screen.getByTestId('issue-workflow-plan-replan')).toBeDisabled()

    fireEvent.click(screen.getByTestId('issue-workflow-view-activity'))
    expect(onViewActivity).toHaveBeenCalledWith('message-1')
    await waitFor(() => expect(api.getWorkflowPlan).toHaveBeenCalledTimes(1))
  })

  test('opens a materialized plan task', async () => {
    const onOpenTask = vi.fn()
    const runningPlan: WorkflowPlan = {
      ...plan,
      status: 'running',
      items: [
        {
          id: 'plan-item-1',
          client_key: 'implementation',
          stage_id: '__issue__',
          title: 'Implement quicksort',
          description: '',
          assignee_type: 'agent',
          assignee_id: 'agent-1',
          assignee_name: 'Developer bot',
          rationale: '',
          depends_on: [],
          task_id: 'ISSUE-2',
          task_status: 'in_progress',
          status: 'materialized',
        },
      ],
      coordinator_run: {
        ...plan.coordinator_run!,
        status: 'succeeded',
      },
    }
    const api = {
      getWorkflowPlan: vi.fn().mockResolvedValue(runningPlan),
      getLoopItem: vi.fn().mockResolvedValue(item),
    }

    render(
      <IssueWorkflowPlan
        api={api as never}
        item={item}
        onUpdated={vi.fn()}
        onOpenTask={onOpenTask}
      />
    )

    fireEvent.click(await screen.findByTestId('issue-workflow-plan-item-plan-item-1'))

    expect(screen.getByTestId('issue-workflow-plan-item-plan-item-1')).toHaveTextContent(
      'todo.workflow_plan_view_execution'
    )
    expect(onOpenTask).toHaveBeenCalledWith('ISSUE-2')
  })

  test('refreshes the board after approving a plan', async () => {
    const onChanged = vi.fn()
    const awaitingPlan: WorkflowPlan = {
      ...plan,
      status: 'awaiting_approval',
      items: [
        {
          id: 'plan-item-1',
          client_key: 'implementation',
          stage_id: '__issue__',
          title: 'Implement quicksort',
          description: '',
          assignee_type: 'agent',
          assignee_id: 'agent-1',
          assignee_name: 'Developer bot',
          rationale: '',
          depends_on: [],
          task_id: null,
          task_status: null,
          status: 'proposed',
        },
      ],
      coordinator_run: {
        ...plan.coordinator_run!,
        status: 'succeeded',
      },
    }
    const approvedPlan: WorkflowPlan = {
      ...awaitingPlan,
      status: 'running',
      items: [
        {
          ...awaitingPlan.items[0],
          task_id: 'ISSUE-2',
          task_status: 'pending',
          status: 'materialized',
        },
      ],
    }
    const updatedItem = {
      ...item,
      workflow: { ...item.workflow!, orchestration_status: 'running' as const },
    }
    const api = {
      getWorkflowPlan: vi.fn().mockResolvedValue(awaitingPlan),
      getLoopItem: vi.fn().mockResolvedValue(updatedItem),
      approveWorkflowPlan: vi.fn().mockResolvedValue(approvedPlan),
    }

    render(
      <IssueWorkflowPlan api={api as never} item={item} onUpdated={vi.fn()} onChanged={onChanged} />
    )

    fireEvent.click(await screen.findByTestId('issue-workflow-plan-approve'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  test('shows the concrete child task status after approval', async () => {
    const runningPlan: WorkflowPlan = {
      ...plan,
      status: 'running',
      items: [
        {
          id: 'plan-item-1',
          client_key: 'implementation',
          stage_id: '__issue__',
          title: 'Implement quicksort',
          description: '',
          assignee_type: 'agent',
          assignee_id: 'agent-1',
          assignee_name: 'Developer bot',
          rationale: 'Matches development capability',
          depends_on: [],
          task_id: 'ISSUE-2',
          task_status: 'in_progress',
          status: 'materialized',
        },
      ],
      coordinator_run: {
        ...plan.coordinator_run!,
        status: 'succeeded',
      },
    }
    const api = {
      getWorkflowPlan: vi.fn().mockResolvedValue(runningPlan),
      getLoopItem: vi.fn().mockResolvedValue(item),
    }

    render(<IssueWorkflowPlan api={api as never} item={item} onUpdated={vi.fn()} />)

    expect(await screen.findByTestId('issue-workflow-plan-item-plan-item-1')).toHaveTextContent(
      'todo.cloud_todo_status_in_progress'
    )
    expect(screen.getByTestId('issue-workflow-plan-item-plan-item-1')).not.toHaveTextContent(
      'Matches development capability'
    )
  })
})
