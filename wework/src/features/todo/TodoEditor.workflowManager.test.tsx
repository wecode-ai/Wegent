import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject, WorkflowPlan } from '@/api/deliveries'

const { openWorkflowManagerExecution } = vi.hoisted(() => ({
  openWorkflowManagerExecution: vi.fn(),
}))

vi.mock('./TaskActivityView', () => ({
  TaskActivityView: ({
    onWorkflowManagerExecutionChange,
  }: {
    onWorkflowManagerExecutionChange?: (action: (() => void) | null) => void
  }) => {
    useEffect(() => {
      onWorkflowManagerExecutionChange?.(openWorkflowManagerExecution)
      return () => onWorkflowManagerExecutionChange?.(null)
    }, [onWorkflowManagerExecutionChange])
    return <div data-testid="mock-task-activity-view" />
  },
}))

import { TodoEditor } from './TodoEditor'

const item = {
  id: 'WEG-1',
  cloud_project_id: '11',
  title: 'AI dynamic allocation',
  description: 'Generate a frontend and backend implementation',
  status: 'in_progress',
  priority: 'medium',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: null,
  created_at: '2026-08-26T00:00:00',
  updated_at: '2026-08-26T00:00:00',
  version: 1,
  workflow: {
    version: 1,
    definition_version: 1,
    stage_mode: 'none',
    advancement_policy: 'ai',
    approval_policy: 'required',
    orchestration_status: 'planning',
    active_run_id: 'workflow-run-1',
    active_plan_version: 1,
    current_stage_id: null,
    nodes: [],
  },
} as unknown as CloudLoopItem

const project = {
  id: '11',
  name: 'Wework',
} as unknown as CloudProject

const plan: WorkflowPlan = {
  run_id: 'workflow-run-1',
  issue_id: item.id,
  stage_id: '__issue__',
  plan_version: 1,
  approval_policy: 'required',
  status: 'planning',
  summary: '',
  items: [],
  manager_run: {
    id: 'manager-run-1',
    status: 'queued',
    recent_activity: '正在进入执行队列',
    error: null,
    updated_at: '2026-08-26T00:00:00Z',
  },
}

describe('TodoEditor workflow manager execution', () => {
  it('opens the queued manager execution by clicking the whole manager card', async () => {
    const user = userEvent.setup()
    const api = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      getWorkflowPlan: vi.fn(async () => plan),
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
        projectChatClient={{} as never}
        currentUserId={1}
      />
    )

    const managerCard = await screen.findByTestId('cloud-todo-workflow-manager-run')
    expect(managerCard).toBeEnabled()
    expect(screen.getByTestId('cloud-todo-workflow-manager-open-execution')).toBeInTheDocument()

    await user.click(managerCard)

    expect(openWorkflowManagerExecution).toHaveBeenCalledTimes(1)
  })
})
