import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

vi.mock('./TaskActivityView', () => ({
  TaskActivityView: () => {
    const [draft, setDraft] = useState('')
    return (
      <textarea
        data-testid="activity-draft"
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
    )
  },
}))

const project = { id: '11', name: 'Project' } as CloudProject
const item = {
  id: 'ISSUE-1',
  cloud_project_id: project.id,
  title: 'Issue',
  description: '',
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
  status: 'pending',
  version: 1,
  assignee_agent_id: 'agent-1',
  assignee_team_id: null,
  assignee_user_id: null,
  tags: [],
  can_edit: true,
} as CloudLoopItem
const api = {
  listDeliveries: vi.fn(async () => ({ items: [] })),
  listTaskBindings: vi.fn(async () => []),
  listLoopItemAttachments: vi.fn(async () => []),
  listLoopItemCollaborators: vi.fn(async () => []),
  listCloudProjectMembers: vi.fn(async () => []),
} as never
const client = {} as never

function editor(issue: CloudLoopItem) {
  return (
    <TodoEditor
      mode="edit"
      item={issue}
      project={project}
      allItems={[issue]}
      onUpdated={vi.fn()}
      onClose={vi.fn()}
      api={api}
      projectChatClient={client}
    />
  )
}

it('keeps the activity draft mounted when a refreshed Issue changes its assignee', () => {
  const view = render(editor(item))
  const composer = screen.getByTestId('activity-draft')
  fireEvent.change(composer, { target: { value: 'Unsent comment' } })

  view.rerender(editor({ ...item, version: 2, assignee_agent_id: 'agent-2' }))

  expect(screen.getByTestId('activity-draft')).toBe(composer)
  expect(composer).toHaveValue('Unsent comment')
})

it('starts a fresh activity draft when opening a different Issue', () => {
  const view = render(editor(item))
  const composer = screen.getByTestId('activity-draft')
  fireEvent.change(composer, { target: { value: 'Unsent comment' } })

  view.rerender(editor({ ...item, id: 'ISSUE-2' }))

  expect(screen.getByTestId('activity-draft')).not.toBe(composer)
  expect(screen.getByTestId('activity-draft')).toHaveValue('')
})
