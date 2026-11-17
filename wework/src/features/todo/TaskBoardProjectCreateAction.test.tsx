import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { CollaborationMember, SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { navigateTo } from '@/lib/navigation'
import type { User } from '@/types/api'
import i18n from '@/i18n'
import { TaskBoardProjectCreateAction } from './TaskBoardProjectCreateAction'

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

const owner = { id: 1, user_id: 1, user_name: 'owner', email: null, role: 'Owner' as const }

afterEach(() => {
  vi.clearAllMocks()
})

function fixture() {
  const members: CollaborationMember[] = [owner]
  const create = vi.fn(async () => ({ id: 'created-project', name: 'Team project' }))
  const list = vi.fn(async () => [...members])
  const add = vi.fn(async (_projectId: string, userId: number) => {
    const member = {
      ...owner,
      id: userId,
      user_id: userId,
      user_name: userId === 2 ? 'alice' : 'bob',
      role: 'Developer' as const,
      direct_role: 'Developer' as const,
    }
    members.push(member)
    return member
  })
  const api = {
    projects: { create },
    members: {
      list,
      add,
      searchUsers: vi.fn(async () => [
        owner,
        { id: 2, user_name: 'alice', email: null },
        { id: 3, user_name: 'bob', email: null },
      ]),
    },
  } as unknown as SharedWorkspaceApi
  const view = render(
    <TaskBoardProjectCreateAction
      services={{ sharedWorkspaceApi: api } as WorkbenchServices}
      user={{ id: 1, user_name: 'owner' } as User}
    />
  )
  return { add, create, list, members, view, api }
}

async function selectMembers() {
  await userEvent.click(screen.getByTestId('task-board-header-more'))
  await userEvent.click(screen.getByTestId('task-board-create-project-space'))
  await userEvent.type(screen.getByTestId('cloud-project-name'), 'Team project')
  for (const userId of [2, 3]) {
    await userEvent.click(screen.getByTestId('collaboration-project-create-add-collaborator'))
    await userEvent.type(screen.getByTestId('collaboration-project-create-people-search'), 'member')
    expect(screen.queryByTestId('collaboration-project-create-member-1')).not.toBeInTheDocument()
    await userEvent.click(
      await screen.findByTestId(`collaboration-project-create-member-${userId}`)
    )
  }
  await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))
}

it('labels the ordinary Tasks project entry in English', async () => {
  await i18n.changeLanguage('en')
  try {
    fixture()
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByTestId('task-board-create-project-space')).toHaveTextContent(
      'New project space'
    )
  } finally {
    await i18n.changeLanguage('zh-CN')
  }
})

it('waits for the server roster before opening a project created from Tasks', async () => {
  const { add, create, list, members, view, api } = fixture()
  let resolveRoster!: (value: CollaborationMember[]) => void
  const confirmed = new Promise<CollaborationMember[]>(resolve => {
    resolveRoster = resolve
  })
  list.mockImplementation(async () => (members.length === 3 ? confirmed : [...members]))
  await selectMembers()
  await waitFor(() => expect(add).toHaveBeenCalledTimes(2))
  expect(navigateTo).not.toHaveBeenCalled()
  expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
  expect(screen.getByTestId('cloud-project-name')).toHaveValue('Team project')
  resolveRoster([...members])
  await waitFor(() =>
    expect(navigateTo).toHaveBeenCalledWith('/todo?projectStore=backend&projectId=created-project')
  )
  expect(create).toHaveBeenCalledOnce()
  view.rerender(
    <TaskBoardProjectCreateAction
      services={{ sharedWorkspaceApi: api } as WorkbenchServices}
      user={{ id: 1, user_name: 'owner' } as User}
      active={false}
    />
  )
  expect(screen.queryByTestId('task-board-header-more')).not.toBeInTheDocument()
  expect(screen.getByTestId('transient-notice')).toBeVisible()
  expect(screen.getByTestId('transient-notice')).toHaveTextContent('alice, bob')
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Team project' }))
  for (const id of [2, 3]) {
    expect(add).toHaveBeenCalledWith('created-project', id, 'Developer', {
      roleMode: 'at_least',
    })
  }
})

it('retains the same project and selected people when a Tasks member addition needs retry', async () => {
  const { add, create } = fixture()
  const addMember = add.getMockImplementation()!
  let denyBob = true
  add.mockImplementation(async (projectId, userId) => {
    if (userId === 3 && denyBob) throw new Error('Permission denied')
    return addMember(projectId, userId)
  })
  await selectMembers()
  expect(await screen.findByText(/Permission denied/)).toBeVisible()
  expect(navigateTo).not.toHaveBeenCalled()
  expect(screen.getByTestId('cloud-project-name')).toHaveValue('Team project')
  expect(screen.getByTestId('collaboration-project-create-selected-member-3')).toHaveTextContent(
    'bob'
  )
  denyBob = false
  await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))
  await waitFor(() => expect(navigateTo).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledOnce()
  expect(add.mock.calls.map(call => call[1])).toEqual([2, 3, 3])
})
