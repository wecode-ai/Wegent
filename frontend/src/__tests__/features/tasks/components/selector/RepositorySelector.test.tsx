// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RepositorySelector from '@/features/tasks/components/selector/RepositorySelector'
import { githubApis } from '@/apis/github'
import { GitRepoInfo } from '@/types/api'

// Mock ResizeObserver for cmdk component
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Mock scrollIntoView for cmdk component
Element.prototype.scrollIntoView = jest.fn()

// Mock dependencies
jest.mock('@/apis/github', () => ({
  githubApis: {
    getRepositories: jest.fn(),
    searchRepositories: jest.fn(),
    refreshRepositories: jest.fn(),
  },
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      git_info: [{ id: 1, name: 'github' }],
    },
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'branches.search_repository': 'Search repository...',
        'branches.select_repository': 'Select repository',
        'branches.no_match': 'No match found',
        'branches.refresh_success': 'Refresh successful',
        'branches.refresh_failed': 'Refresh failed',
        'branches.refreshing': 'Refreshing...',
        'branches.configure_integration': 'Configure Integration',
        'branches.load_more': 'Load more',
        'actions.refresh': 'Refresh',
        'repos.repository_tooltip': 'Select repository',
      }
      return translations[key] || key
    },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/utils/userPreferences', () => ({
  getLastRepo: jest.fn(() => null),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

// Mock data
const mockRepos: GitRepoInfo[] = [
  {
    git_repo_id: 1,
    name: 'repo-1',
    git_repo: 'owner/repo-1',
    git_url: 'https://github.com/owner/repo-1',
    git_domain: 'github.com',
    private: false,
    type: 'github',
  },
  {
    git_repo_id: 2,
    name: 'repo-2',
    git_repo: 'owner/repo-2',
    git_url: 'https://github.com/owner/repo-2',
    git_domain: 'github.com',
    private: false,
    type: 'github',
  },
  {
    git_repo_id: 3,
    name: 'repo-3',
    git_repo: 'owner/repo-3',
    git_url: 'https://github.com/owner/repo-3',
    git_domain: 'github.com',
    private: false,
    type: 'github',
  },
]

const mockSearchResults: GitRepoInfo[] = [
  {
    git_repo_id: 4,
    name: 'video-app',
    git_repo: 'owner/video-app',
    git_url: 'https://github.com/owner/video-app',
    git_domain: 'github.com',
    private: false,
    type: 'github',
  },
]

describe('RepositorySelector', () => {
  const mockHandleRepoChange = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(githubApis.getRepositories as jest.Mock).mockResolvedValue(mockRepos)
    ;(githubApis.searchRepositories as jest.Mock).mockResolvedValue(mockSearchResults)
    ;(githubApis.refreshRepositories as jest.Mock).mockResolvedValue(undefined)
  })

  it('should load repositories on initial mount', async () => {
    render(
      <RepositorySelector
        selectedRepo={null}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait for initial load (may be called multiple times due to React StrictMode)
    await waitFor(() => {
      expect(githubApis.getRepositories).toHaveBeenCalled()
    })
  })

  it('should NOT reload repositories when search returns empty results', async () => {
    // Mock search to return empty results
    ;(githubApis.searchRepositories as jest.Mock).mockResolvedValue([])

    const user = userEvent.setup()

    render(
      <RepositorySelector
        selectedRepo={null}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait for initial load
    await waitFor(() => {
      expect(githubApis.getRepositories).toHaveBeenCalled()
    })

    // Record how many times getRepositories was called during initial load
    const initialCallCount = (githubApis.getRepositories as jest.Mock).mock.calls.length

    // Find and click the selector to open the popover
    const trigger = screen.getByRole('combobox')
    await user.click(trigger)

    // Type a search query that returns no results
    const searchInput = screen.getByPlaceholderText('Search repository...')
    await user.type(searchInput, 'nonexistent-repo')

    // Wait for debounce and search to complete
    await waitFor(
      () => {
        expect(githubApis.searchRepositories).toHaveBeenCalledWith('nonexistent-repo', {
          fullmatch: false,
          timeout: 30,
        })
      },
      { timeout: 1000 }
    )

    // Wait a bit more for any potential side effects
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    // The key assertion: getRepositories should NOT be called again after search
    // even though search returned empty results and repos.length becomes 0
    expect((githubApis.getRepositories as jest.Mock).mock.calls.length).toBe(initialCallCount)
  })

  it('should restore cached repos when search is cleared', async () => {
    const user = userEvent.setup()

    render(
      <RepositorySelector
        selectedRepo={null}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait for initial load
    await waitFor(() => {
      expect(githubApis.getRepositories).toHaveBeenCalled()
    })

    // Record initial call count
    const initialCallCount = (githubApis.getRepositories as jest.Mock).mock.calls.length

    // Open selector
    const trigger = screen.getByRole('combobox')
    await user.click(trigger)

    // Type a search query
    const searchInput = screen.getByPlaceholderText('Search repository...')
    await user.type(searchInput, 'video')

    // Wait for search
    await waitFor(
      () => {
        expect(githubApis.searchRepositories).toHaveBeenCalled()
      },
      { timeout: 1000 }
    )

    // Clear search input
    await user.clear(searchInput)

    // Wait a bit for any potential side effects
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    // Should NOT call getRepositories - should use cached repos
    expect((githubApis.getRepositories as jest.Mock).mock.calls.length).toBe(initialCallCount)
  })

  it('should only load repositories during initial mount, not on rerender with selected repo', async () => {
    const { rerender } = render(
      <RepositorySelector
        selectedRepo={null}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait for initial load
    await waitFor(() => {
      expect(githubApis.getRepositories).toHaveBeenCalled()
    })

    // Record initial call count
    const initialCallCount = (githubApis.getRepositories as jest.Mock).mock.calls.length

    // Rerender with a selected repo
    rerender(
      <RepositorySelector
        selectedRepo={mockRepos[0]}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait a bit for any potential side effects
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    // Should not trigger additional getRepositories calls
    expect((githubApis.getRepositories as jest.Mock).mock.calls.length).toBe(initialCallCount)
  })

  it('should not reload full repository list when search returns empty results', async () => {
    // Mock both local and remote search to return empty
    ;(githubApis.searchRepositories as jest.Mock).mockResolvedValue([])

    const user = userEvent.setup()

    render(
      <RepositorySelector
        selectedRepo={null}
        handleRepoChange={mockHandleRepoChange}
        disabled={false}
      />
    )

    // Wait for initial load
    await waitFor(() => {
      expect(githubApis.getRepositories).toHaveBeenCalled()
    })

    // Record initial call count
    const initialCallCount = (githubApis.getRepositories as jest.Mock).mock.calls.length

    // Open selector
    const trigger = screen.getByRole('combobox')
    await user.click(trigger)

    // Type a search query that returns no results (not matching any local repos)
    const searchInput = screen.getByPlaceholderText('Search repository...')
    await user.type(searchInput, 'zzz-nonexistent')

    // Wait for search to complete
    await waitFor(
      () => {
        expect(githubApis.searchRepositories).toHaveBeenCalled()
      },
      { timeout: 1000 }
    )

    // Wait a bit more for any potential side effects
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    // The key assertion: getRepositories should NOT be called again
    // This is the bug we fixed - empty search results should not trigger a full reload
    expect((githubApis.getRepositories as jest.Mock).mock.calls.length).toBe(initialCallCount)
  })
})
