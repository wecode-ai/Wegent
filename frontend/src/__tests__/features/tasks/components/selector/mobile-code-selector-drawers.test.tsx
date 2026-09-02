// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MobileRepositorySelector from '@/features/tasks/components/selector/MobileRepositorySelector'
import type { GitBranch, GitRepoInfo } from '@/types/api'

const mockPush = jest.fn()
const mockResetSearch = jest.fn()
const mockGetBranches = jest.fn()

const mockRepo: GitRepoInfo = {
  git_repo_id: 1,
  name: 'Wegent',
  git_repo: 'wecode-ai/Wegent',
  git_url: 'https://github.com/wecode-ai/Wegent',
  git_domain: 'github.com',
  private: false,
  type: 'github',
}

const mockBranch: GitBranch = {
  name: 'main',
  protected: true,
  default: true,
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'mobile_composer.workspace': '仓库 / 分支',
        'mobile_composer.not_selected': '未选择',
        'common:repos.repository': '选择仓库',
        'common:repos.branch': '选择分支',
        'common:branches.search_repository': '搜索仓库...',
        'common:branches.search_branch': '搜索分支...',
        'common:branches.default': '(默认)',
        'common:branches.loading': '加载分支中...',
      }
      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/features/tasks/hooks/useRepositorySearch', () => ({
  useRepositorySearch: () => ({
    repos: [mockRepo],
    loading: false,
    isRefreshing: false,
    error: null,
    currentSearchQuery: '',
    handleSearchChange: jest.fn(),
    handleRefreshCache: jest.fn(),
    resetSearch: mockResetSearch,
  }),
}))

jest.mock('@/apis/github', () => ({
  githubApis: {
    getBranches: (...args: unknown[]) => mockGetBranches(...args),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/features/tasks/components/selector/RepositorySelectorFooter', () => ({
  RepositorySelectorFooter: () => <div data-testid="repository-selector-footer" />,
}))

jest.mock('@/components/ui/drawer', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react')
  const DrawerContext = ReactModule.createContext({
    open: false,
    onOpenChange: (_open: boolean) => {},
  })

  return {
    Drawer: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => (
      <DrawerContext.Provider value={{ open, onOpenChange }}>{children}</DrawerContext.Provider>
    ),
    DrawerTrigger: ({ children }: { children: React.ReactElement }) => {
      const drawer = ReactModule.useContext(DrawerContext)
      return ReactModule.cloneElement(
        children as React.ReactElement<{ onClick?: React.MouseEventHandler }>,
        {
          onClick: () => drawer.onOpenChange(true),
        }
      )
    },
    DrawerContent: ({
      children,
      showHandle: _showHandle,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { showHandle?: boolean }) => {
      const drawer = ReactModule.useContext(DrawerContext)
      return drawer.open ? <div {...props}>{children}</div> : null
    },
    DrawerTitle: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props} />,
  }
})

jest.mock('@/components/ui/command', () => ({
  Command: ({
    children,
    shouldFilter: _shouldFilter,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { shouldFilter?: boolean }) => (
    <div {...props}>{children}</div>
  ),
  CommandInput: ({
    onValueChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    onValueChange?: (value: string) => void
  }) => <input {...props} onChange={event => onValueChange?.(event.target.value)} />,
}))

function WorkspaceSelectorHarness({
  onSelectorOpenChange,
}: {
  onSelectorOpenChange: (open: boolean) => void
}) {
  const [selectedRepo, setSelectedRepo] = React.useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = React.useState<GitBranch | null>(null)

  return (
    <MobileRepositorySelector
      selectedRepo={selectedRepo}
      handleRepoChange={setSelectedRepo}
      selectedBranch={selectedBranch}
      handleBranchChange={setSelectedBranch}
      disabled={false}
      onSelectorOpenChange={onSelectorOpenChange}
    />
  )
}

describe('mobile repository and branch cascade', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetBranches.mockResolvedValue([mockBranch])
  })

  it('selects repository and branch inside one drawer', async () => {
    const onSelectorOpenChange = jest.fn()

    render(<WorkspaceSelectorHarness onSelectorOpenChange={onSelectorOpenChange} />)

    fireEvent.click(screen.getByTestId('mobile-repository-selector-trigger'))

    const drawer = screen.getByTestId('mobile-repository-selector-drawer')
    expect(drawer).toHaveClass('max-h-[85vh]', 'bg-[#f2f2f7]')
    expect(screen.getByText('选择仓库')).toBeInTheDocument()
    expect(screen.getByTestId('repository-selector-footer')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mobile-repository-option'))

    expect(screen.getByTestId('mobile-repository-selector-drawer')).toBeInTheDocument()
    expect(screen.getByText('选择分支')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-workspace-back-to-repositories')).toHaveTextContent(
      'wecode-ai/Wegent'
    )
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true)

    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledWith(mockRepo))
    fireEvent.click(await screen.findByTestId('mobile-branch-option'))

    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByTestId('mobile-repository-selector-drawer')).not.toBeInTheDocument()
    expect(screen.getByText('wecode-ai/Wegent · main')).toBeInTheDocument()
  })
})
