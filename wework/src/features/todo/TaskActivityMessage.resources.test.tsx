import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IssueMarkdownProvider } from '@wegent/collaboration'
import type { SharedWorkspaceAttachmentsApi } from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { ChatMessage } from './TaskActivityMessage'

const mocks = vi.hoisted(() => ({ viewerRead: vi.fn(), visualization: vi.fn() }))
vi.mock('./useActivityExecutionStatus', () => ({
  useActivityExecutionDisplayStatus: () => ({ status: undefined }),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
vi.mock('@/components/chat/useDesktopMarkdownServices', async () => {
  const { browserMarkdownServices } = await import('@wegent/collaboration/markdown')
  return {
    useDesktopMarkdownServices: () => ({
      ...browserMarkdownServices,
      readLocalFile: mocks.viewerRead,
      renderVisualization: mocks.visualization,
    }),
  }
})

const message: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'reply',
  projectId: 'project-1',
  taskId: 'issue-6',
  sender: { type: 'agent', id: 'agent', name: 'Assistant' },
  type: 'text',
  content: '',
  metadata: {},
  status: 'completed',
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn().mockReturnValue('blob:owned-image')
      static revokeObjectURL = vi.fn()
    }
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('does not grant a shared Issue message access to viewer-local files when its resource context is absent', async () => {
  render(
    <ChatMessage
      mine={false}
      plain
      message={{ ...message, content: '![private](/Users/viewer/private.png)' }}
    />
  )
  await screen.findByTestId('assistant-markdown-image-error')
  expect(mocks.viewerRead).not.toHaveBeenCalled()
  expect(mocks.visualization).not.toHaveBeenCalled()
})

it('retains the owning Issue image reader through the desktop message adapter', async () => {
  const read = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const list = vi
    .fn()
    .mockResolvedValue([
      { id: 'owned-image', display_name: 'owned.png', content_type: 'image/png' },
    ])
  render(
    <IssueMarkdownProvider
      attachments={{ list, read } as unknown as SharedWorkspaceAttachmentsApi}
      issueId="issue-6"
      projectId="project-1"
    >
      <ChatMessage
        mine={false}
        plain
        message={{ ...message, content: '![Owned](/home/executor/owned.png)' }}
      />
    </IssueMarkdownProvider>
  )
  expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
    'src',
    'blob:owned-image'
  )
  expect(list).toHaveBeenCalledWith('issue-6')
  expect(read).toHaveBeenCalledWith('owned-image', { projectId: 'project-1', issueId: 'issue-6' })
  expect(mocks.viewerRead).not.toHaveBeenCalled()
})
