// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UnifiedRepositorySelector from '@/features/tasks/components/selector/UnifiedRepositorySelector'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const mockResetSearch = jest.fn()

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))
jest.mock('@/features/layout/hooks/useMediaQuery', () => ({ useIsMobile: () => false }))
jest.mock('@/features/tasks/session/TaskSession', () => ({
  TaskSessionContext: jest.requireActual('react').createContext(null),
}))
jest.mock('@/features/tasks/hooks/useRepositorySearch', () => ({
  useRepositorySearch: () => ({
    repos: [],
    loading: false,
    isSearching: false,
    isRefreshing: false,
    error: null,
    handleSearchChange: jest.fn(),
    handleRefreshCache: jest.fn(),
    handleChange: jest.fn(),
    resetSearch: mockResetSearch,
  }),
}))
jest.mock('@/features/tasks/components/selector/RepoListView', () => ({
  RepoListView: ({ onClearSelection }: { onClearSelection?: () => void }) => (
    <div data-testid="repository-list">
      Repositories
      {onClearSelection && <button onClick={onClearSelection}>No repository needed</button>}
    </div>
  ),
}))

const onRepoChange = jest.fn()
const onBranchChange = jest.fn()
const onRequiresWorkspaceChange = jest.fn()

function Selectors({ requiresWorkspace }: { requiresWorkspace: boolean }) {
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button>Choose agent</button>
        </PopoverTrigger>
        <PopoverContent>
          <input aria-label="Agent search" />
        </PopoverContent>
      </Popover>
      <UnifiedRepositorySelector
        selectedRepo={null}
        selectedBranch={null}
        onRepoChange={onRepoChange}
        onBranchChange={onBranchChange}
        onRequiresWorkspaceChange={onRequiresWorkspaceChange}
        requiresWorkspace={requiresWorkspace}
      />
    </>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
})

afterEach(() => {
  act(() => jest.runOnlyPendingTimers())
  jest.useRealTimers()
})

it('keeps agent selection and focus intact when a late team requires a workspace', async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  const view = render(<Selectors requiresWorkspace={false} />)
  await user.click(screen.getByRole('button', { name: 'Choose agent' }))
  const search = screen.getByRole('textbox', { name: 'Agent search' })
  await user.click(search)

  view.rerender(<Selectors requiresWorkspace />)
  act(() => jest.runOnlyPendingTimers())

  expect(screen.getByRole('textbox', { name: 'Agent search' })).toBe(search)
  expect(search).toHaveFocus()
  expect(screen.queryByTestId('repository-list')).not.toBeInTheDocument()
  expect(onRequiresWorkspaceChange).not.toHaveBeenCalled()
})

it('opens on user request and clears the repository and branch through the existing action', async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  render(<Selectors requiresWorkspace />)

  await user.click(screen.getByTestId('repository-selector-trigger'))
  expect(screen.getByTestId('repository-list')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'No repository needed' }))

  expect(onRequiresWorkspaceChange).toHaveBeenCalledWith(false)
  expect(onRepoChange).toHaveBeenCalledWith(null)
  expect(onBranchChange).toHaveBeenCalledWith(null)
})
