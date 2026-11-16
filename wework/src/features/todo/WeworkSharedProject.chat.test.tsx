import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import type { CollaborationApp } from '@wegent/collaboration'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'
import type { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))
vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationApp: ({ host, initialProject }: ComponentProps<typeof CollaborationApp>) => (
    <>
      {host.renderProjectHeaderAction?.(initialProject!)}
      {host.renderBoardToolbarAction?.(initialProject!)}
    </>
  ),
}))
vi.mock('./ProjectSpaceChatSidebar', () => ({
  ProjectSpaceChatSidebar: ({
    project,
    localExecution,
    onClose,
  }: ComponentProps<typeof ProjectSpaceChatSidebar>) => (
    <aside data-testid="chat-sidebar" data-local={String(localExecution)}>
      {project.name}
      <button data-testid="chat-close" onClick={onClose}>
        Close
      </button>
    </aside>
  ),
}))

it.each(['local', 'backend'] as const)(
  'opens and closes the %s project chat without experimental features or group requests',
  async projectStore => {
    const listGroups = vi.fn()
    const onOpenProjectConversation = vi.fn()
    const project = { id: 'p1', name: 'Current board', project_store: projectStore }
    const props = {
      api: {
        projects: { listCollaborationGroups: listGroups },
        issues: {},
      },
      project,
      localProjects: [],
      locale: 'en',
      location: { projectId: 'p1', projectView: 'board', issueId: null },
      services: {},
      userId: 1,
      workspace: { id: 'w1', name: 'Workspace' },
      setLocation: vi.fn(),
      onOpenProjectConversation,
    } as unknown as ComponentProps<typeof WeworkSharedProject>
    const { rerender } = render(<WeworkSharedProject {...props} />)
    const user = userEvent.setup()
    expect(screen.queryByTestId('chat-sidebar')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('project-space-chat-open'))
    expect(onOpenProjectConversation).toHaveBeenCalledOnce()
    rerender(<WeworkSharedProject {...props} conversationRequestKey="request-one" />)
    expect(screen.getByTestId('chat-sidebar')).toHaveTextContent(project.name)
    expect(screen.getByTestId('chat-sidebar')).toHaveAttribute('data-local', 'true')
    expect(screen.getByTestId('project-space-chat-open')).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByTestId('chat-close'))
    expect(screen.queryByTestId('chat-sidebar')).not.toBeInTheDocument()
    rerender(<WeworkSharedProject {...props} conversationRequestKey="request-two" />)
    expect(screen.getByTestId('chat-sidebar')).toBeInTheDocument()
    expect(listGroups).not.toHaveBeenCalled()
  }
)
