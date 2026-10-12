import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

const project = { id: '11', name: 'Wework' } as CloudProject
const api = {
  listDeliveries: vi.fn(async () => ({ items: [] })),
  listTaskBindings: vi.fn(async () => []),
  listLoopItemAttachments: vi.fn(async () => []),
  listLoopItemCollaborators: vi.fn(async () => []),
  listCloudProjectMembers: vi.fn(async () => []),
} as never

function showIssue(ai_state: CloudLoopItem['ai_state']) {
  const item = {
    id: 'TIME-1',
    cloud_project_id: '11',
    title: 'Inspect duration',
    description: '',
    status: 'in_review',
    priority: 'none',
    parent_id: null,
    due_at: null,
    tags: [],
    assignee_user_id: null,
    assignee_agent_id: null,
    created_at: '2026-10-08T12:27:21Z',
    updated_at: '2026-10-08T12:34:54Z',
    version: 1,
    can_edit: true,
    ai_state,
  } as CloudLoopItem
  return render(
    <TodoEditor
      mode="edit"
      presentation="workspace-panel"
      item={item}
      project={project}
      allItems={[item]}
      api={api}
      onUpdated={vi.fn()}
      onClose={vi.fn()}
      initialTaskBindings={[
        {
          id: 'binding-88',
          loop_item_id: item.id,
          task_user_id: 2,
          device_id: 'remote-device',
          task_id: 'run-88',
          task_title: 'Run 88',
          backend_task_id: null,
          linked_at: '2026-10-08T12:27:23',
        },
      ]}
    />
  )
}

describe('Issue execution duration', () => {
  it('uses actual execution timestamps and freezes at completion, not task linking time', () => {
    const state = {
      status: 'succeeded',
      started_at: '2026-10-08T12:27:24',
      completed_at: '2026-10-08T12:34:54',
    }
    const view = showIssue(state)
    expect(screen.getByTestId('cloud-todo-execution-duration')).toHaveTextContent('7 分钟')
    view.unmount()
    showIssue({ ...state, started_at: '2026-10-08T20:27:24+08:00' })
    expect(screen.getByTestId('cloud-todo-execution-duration')).toHaveTextContent('7 分钟')
  })

  it('does not show execution time just because a queued task has been linked', () => {
    showIssue({ status: 'queued' })
    expect(screen.queryByTestId('cloud-todo-execution-duration')).not.toBeInTheDocument()
  })
})
