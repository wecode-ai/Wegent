import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorktreeBranchSelector } from './WorktreeBranchSelector'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { resolve, promise }
}

test('loads on opening, focuses search, filters branches and returns to the trigger after selection', async () => {
  const load = vi.fn(async () => ['main', 'feature/alpha'])
  const select = vi.fn()
  render(
    <WorktreeBranchSelector currentBranch="main" onListBranches={load} onSelectBranch={select} />
  )
  expect(load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  expect(screen.getByTestId('project-worktree-branch-search-input')).toHaveFocus()
  await screen.findByText('feature/alpha')
  fireEvent.change(screen.getByTestId('project-worktree-branch-search-input'), {
    target: { value: 'alpha' },
  })
  expect(screen.getAllByTestId('project-worktree-branch-option')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('project-worktree-branch-option'))
  expect(select).toHaveBeenCalledExactlyOnceWith('feature/alpha')
  expect(screen.queryByTestId('project-worktree-branch-menu')).toBeNull()
  expect(screen.getByTestId('project-worktree-branch-button')).toHaveFocus()
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  fireEvent.click(await screen.findByRole('option', { name: 'main' }))
  expect(select).toHaveBeenLastCalledWith(null)
})

test('ignores a previous workspace catalog when the active loader changes', async () => {
  const old = pending<string[]>()
  const oldLoad = vi.fn(() => old.promise)
  const newLoad = vi.fn(async () => ['new/main'])
  const select = vi.fn()
  const { rerender } = render(
    <WorktreeBranchSelector onListBranches={oldLoad} onSelectBranch={select} />
  )
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  expect(oldLoad).toHaveBeenCalledOnce()
  rerender(<WorktreeBranchSelector onListBranches={newLoad} onSelectBranch={select} />)
  await screen.findByText('new/main')
  await act(async () => old.resolve(['old/main']))
  expect(screen.queryByText('old/main')).toBeNull()
  expect(screen.getByText('new/main')).toBeInTheDocument()
  expect(newLoad).toHaveBeenCalledOnce()
})

test('cancels a closed read and ignores it when the same menu is reopened', async () => {
  const old = pending<string[]>()
  const fresh = pending<string[]>()
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise)
  render(<WorktreeBranchSelector onListBranches={load} onSelectBranch={vi.fn()} />)
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
  expect(screen.getByTestId('project-worktree-branch-menu')).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('project-worktree-branch-menu')).toBeNull()
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => fresh.resolve(['fresh/main']))
  await act(async () => old.resolve(['old/main']))
  expect(screen.queryByText('old/main')).toBeNull()
  expect(screen.getByText('fresh/main')).toBeInTheDocument()
})

test('retries a failed catalog on the next opening', async () => {
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockRejectedValueOnce(new Error('Git unavailable'))
    .mockResolvedValueOnce(['main'])
  render(<WorktreeBranchSelector onListBranches={load} onSelectBranch={vi.fn()} />)
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  await screen.findByText('Git unavailable')
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByTestId('project-worktree-branch-button'))
  await screen.findByTestId('project-worktree-branch-option')
  expect(screen.queryByText('Git unavailable')).toBeNull()
  expect(load).toHaveBeenCalledTimes(2)
})
