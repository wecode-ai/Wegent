import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import '@/i18n'
import { ProjectCoordinatorConversation } from './ProjectCoordinatorConversation'

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({ emptyStateText }: { emptyStateText: string }) => <p>{emptyStateText}</p>,
}))

function fixture(groups: unknown[] = []) {
  const listCollaborationGroups = vi.fn().mockResolvedValue(groups)
  const projectConversation = vi.fn().mockResolvedValue({ taskId: 'conversation', address: null })
  const onOpenGroupSettings = vi.fn()
  const props = {
    api: { projects: { listCollaborationGroups } },
    project: { id: 'project-a', name: '项目 A', project_store: 'local' },
    services: {
      standInApi: { projectConversation },
      getLocalRuntimeSidebarIdentity: vi.fn().mockResolvedValue({ deviceId: 'mac' }),
    },
    userId: 7,
    devices: [],
    onOpenGroupSettings,
  } as unknown as ComponentProps<typeof ProjectCoordinatorConversation>
  return { props, listCollaborationGroups, projectConversation, onOpenGroupSettings }
}

it('loads only when opened and routes missing groups back to project settings', async () => {
  const f = fixture()
  render(<ProjectCoordinatorConversation {...f.props} />)
  expect(f.listCollaborationGroups).not.toHaveBeenCalled()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('project-coordinator-open'))
  await user.click(await screen.findByTestId('project-coordinator-configure-group'))
  expect(f.onOpenGroupSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('does not create an AI conversation for a human leader', async () => {
  const f = fixture([
    { id: 'group', name: '交付组', leader: { kind: 'human', id: '7', name: '我' } },
  ])
  render(<ProjectCoordinatorConversation {...f.props} />)
  await userEvent.setup().click(screen.getByTestId('project-coordinator-open'))
  expect(await screen.findByText(/成员担任负责人/)).toBeInTheDocument()
  expect(f.projectConversation).not.toHaveBeenCalled()
})

it('binds the selected AI leader conversation to project, group, user and device', async () => {
  const f = fixture([
    { id: 'group', name: '交付组', leader: { kind: 'agent', id: 'agent', name: '负责人' } },
  ])
  render(<ProjectCoordinatorConversation {...f.props} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('project-coordinator-open'))
  await waitFor(() =>
    expect(f.projectConversation).toHaveBeenCalledWith(7, 'mac', 'project-a', 'local', 'group')
  )
  await user.click(screen.getByTestId('project-coordinator-work-list'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
