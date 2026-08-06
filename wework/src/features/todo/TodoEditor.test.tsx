import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'
import { markdownAttachmentRows } from './attachmentMarkdown'

describe('markdownAttachmentRows', () => {
  it('recognizes provider-native links through the unified attachment marker', () => {
    expect(
      markdownAttachmentRows(
        '[changes.patch](/group/project/uploads/hash/changes.patch)\n' +
          '<!-- wegent-attachment:gitlab-encoded -->'
      )
    ).toEqual([{ id: 'gitlab-encoded', display_name: 'changes.patch', size_bytes: 0 }])
  })

  it('keeps recognizing legacy Wegent attachment links', () => {
    expect(markdownAttachmentRows('[capture.png](wegent://attachments/local-id)')).toEqual([
      { id: 'local-id', display_name: 'capture.png', size_bytes: 0 },
    ])
  })
})

const api = {
  listDeliveries: vi.fn(async () => ({ items: [] })),
  listTaskBindings: vi.fn(async () => []),
  listLoopItemAttachments: vi.fn(async () => []),
  listLoopItemCollaborators: vi.fn(async () => []),
  listCloudProjectMembers: vi.fn(async () => []),
} as never

const baseItem = {
  id: 'WEG-1',
  cloud_project_id: '11',
  title: 'Inspect changes',
  description: 'Review the current diff',
  status: 'in_progress',
  priority: 'high',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: 'agent-1',
  created_at: '2026-08-01T00:00:00',
  updated_at: '2026-08-01T00:00:00',
  version: 1,
} as unknown as CloudLoopItem

const project = { id: '11', name: 'Wework' } as unknown as CloudProject

function editorElement(item: CloudLoopItem) {
  return (
    <TodoEditor
      mode="edit"
      item={item}
      project={project}
      allItems={[item]}
      onUpdated={vi.fn()}
      onAddChild={vi.fn()}
      onClose={vi.fn()}
      api={api}
      currentUserId={1}
    />
  )
}

describe('TodoEditor external item sync', () => {
  it('adopts an external version update in place instead of remounting', () => {
    const view = render(editorElement(baseItem))
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('in_progress')

    view.rerender(editorElement({ ...baseItem, version: 2, status: 'in_review' }))

    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes')
  })

  it('keeps user edits when an external version update arrives', async () => {
    const user = userEvent.setup()
    const view = render(editorElement(baseItem))
    await user.type(screen.getByTestId('cloud-todo-detail-title'), ' 手工补充')

    view.rerender(editorElement({ ...baseItem, version: 2, status: 'completed' }))

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes 手工补充')
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('completed')
  })
})
