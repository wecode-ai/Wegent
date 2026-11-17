import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TodoEditor } from './TodoEditor'
import { useAttachmentPreview } from '@/components/chat/useAttachmentPreview'
import { AttachmentDownloadProvider } from '@/components/chat/AttachmentDownloadProvider'
import type { Attachment } from '@/types/api'

const renderActivity = vi.hoisted(() => vi.fn())
afterEach(() => vi.unstubAllGlobals())

vi.mock('./TaskActivityView', () => ({
  TaskActivityView: (props: unknown) => {
    renderActivity(props)
    const [draft, setDraft] = useState('')
    const preview = useAttachmentPreview()
    return (
      <>
        <button
          data-testid="preview-staged-file"
          onClick={() =>
            preview?.({
              id: 42,
              filename: 'staged-reply.txt',
              mime_type: 'text/plain',
            } as Attachment)
          }
        >
          Preview attachment
        </button>
        <textarea
          data-testid="activity-draft"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      </>
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

it('previews staged reply attachments through the Issue-owned preview surface', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:staged-reply')
      static revokeObjectURL = vi.fn()
    }
  )
  const readFile = vi.fn(async () =>
    Object.assign(new Blob(['staged reply content'], { type: 'text/plain' }), {
      text: async () => 'staged reply content',
    })
  )
  render(
    <AttachmentDownloadProvider fetchAttachmentBlob={readFile}>
      {editor(item)}
    </AttachmentDownloadProvider>
  )
  const trigger = screen.getByTestId('preview-staged-file')
  trigger.focus()
  fireEvent.click(trigger)
  expect(await screen.findByTestId('cloud-file-preview-dialog')).toHaveTextContent(
    'staged-reply.txt'
  )
  expect(await screen.findByTestId('cloud-file-preview-text')).toHaveTextContent(
    'staged reply content'
  )
  await waitFor(() => expect(readFile).toHaveBeenCalledExactlyOnceWith(42))
  expect(screen.getByTestId('cloud-file-preview-close')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('cloud-file-preview-close'), { key: 'Escape' })
  expect(screen.queryByTestId('cloud-file-preview-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('activity-draft')).toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

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

it('starts a fresh activity draft when opening a different Issue', () => {
  const view = render(editor(item))
  const composer = screen.getByTestId('activity-draft')
  fireEvent.change(composer, { target: { value: 'Unsent comment' } })

  view.rerender(editor({ ...item, id: 'ISSUE-2' }))

  expect(screen.getByTestId('activity-draft')).not.toBe(composer)
  expect(screen.getByTestId('activity-draft')).toHaveValue('')
})
