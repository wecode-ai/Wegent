import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceMembersConfiguration } from '../../../packages/collaboration/src/platform/WorkspaceMembersConfiguration'
import type { WorkspaceResourceCommands } from '../../../packages/collaboration/src/platform/WorkspaceResourceConfiguration'
import type {
  CollaborationUser,
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
} from '../../../packages/collaboration/src/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const workspace = { id: 'workspace-one', access_role: 'Owner' } as CollaborationWorkspace
const alice = { id: 1, user_name: 'Alice', email: 'alice@example.test' } as CollaborationUser
const bob = { id: 2, user_name: 'Bob', email: 'bob@example.test' } as CollaborationUser

function fixture(searchUsers = vi.fn().mockResolvedValue([alice, bob])) {
  const commands = { searchUsers, addMember: vi.fn() } as unknown as WorkspaceResourceCommands
  const view = (members: CollaborationWorkspaceMember[] = []) => (
    <WorkspaceMembersConfiguration
      workspace={workspace}
      members={members}
      locale="en"
      commands={commands}
    />
  )
  const result = render(view())
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-invite'))
  return { ...result, view, searchUsers, commands }
}
const search = (value: string) =>
  fireEvent.change(screen.getByTestId('collaboration-workspace-member-search'), {
    target: { value },
  })

it('debounces searches and filters newly added members without another request', async () => {
  const f = fixture()
  search('a')
  search('al')
  await act(async () => vi.advanceTimersByTimeAsync(179))
  expect(f.searchUsers).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(f.searchUsers).toHaveBeenCalledExactlyOnceWith('al')
  expect(screen.getByTestId('collaboration-workspace-member-result-1')).toHaveTextContent('Alice')
  f.rerender(
    f.view([
      {
        user_id: alice.id,
        user_name: alice.user_name,
        role: 'Developer',
      } as CollaborationWorkspaceMember,
    ])
  )
  expect(screen.queryByTestId('collaboration-workspace-member-result-1')).not.toBeInTheDocument()
  expect(screen.getByTestId('collaboration-workspace-member-result-2')).toHaveTextContent('Bob')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  expect(f.searchUsers).toHaveBeenCalledOnce()
})

it('ignores an older query response and cancels debounce when the search is cleared', async () => {
  let finishOld!: (users: CollaborationUser[]) => void
  const searchUsers = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<CollaborationUser[]>(resolve => {
          finishOld = resolve
        })
    )
    .mockResolvedValueOnce([bob])
  const f = fixture(searchUsers)
  search('alice')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  search('bob')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  expect(screen.getByTestId('collaboration-workspace-member-result-2')).toHaveTextContent('Bob')
  await act(async () => finishOld([alice]))
  expect(screen.queryByTestId('collaboration-workspace-member-result-1')).not.toBeInTheDocument()
  search('a')
  search('')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  expect(f.searchUsers).toHaveBeenCalledTimes(2)
  expect(screen.queryByTestId('collaboration-workspace-member-result-2')).not.toBeInTheDocument()
})

it('does not publish a failed search after closing and reopening the invite dialog', async () => {
  let fail!: (cause: unknown) => void
  fixture(
    vi.fn().mockImplementationOnce(
      () =>
        new Promise<CollaborationUser[]>((_resolve, reject) => {
          fail = reject
        })
    )
  )
  search('alice')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-invite-cancel'))
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-invite'))
  await act(async () => fail(new Error('Old transport failed')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('does not let a completed invitation close a newly reopened invite dialog', async () => {
  const f = fixture()
  let finish!: (member: CollaborationWorkspaceMember) => void
  f.commands.addMember = vi.fn(
    () =>
      new Promise<CollaborationWorkspaceMember>(resolve => {
        finish = resolve
      })
  )
  search('alice')
  await act(async () => vi.advanceTimersByTimeAsync(180))
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-result-1'))
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-invite-cancel'))
  fireEvent.click(screen.getByTestId('collaboration-workspace-member-invite'))
  await act(async () =>
    finish({
      user_id: alice.id,
      user_name: alice.user_name,
      role: 'Developer',
    } as CollaborationWorkspaceMember)
  )
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})
