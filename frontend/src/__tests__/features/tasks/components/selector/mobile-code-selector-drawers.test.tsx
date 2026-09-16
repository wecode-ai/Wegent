// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MobileRepositorySelector from '@/features/tasks/components/selector/MobileRepositorySelector'
import type { GitBranch, GitRepoInfo } from '@/types/api'

const mockPush = jest.fn()
const mockGetBranches = jest.fn()
const mockGetRepositories = jest.fn()
const mockGetLastRepo = jest.fn()
const mockUser = { git_info: [{ id: 1, name: 'github' }] }

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUser }),
}))

jest.mock('@/utils/userPreferences', () => ({
  getLastRepo: () => mockGetLastRepo(),
}))

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
        'common:repos.no_workspace_needed': '无需仓库',
        'common:branches.search_repository': '搜索仓库...',
        'common:branches.search_branch': '搜索分支...',
        'common:branches.default': '(默认)',
        'common:branches.loading': '加载分支中...',
      }
      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/apis/github', () => ({
  githubApis: {
    getBranches: (...args: unknown[]) => mockGetBranches(...args),
    getRepositories: () => mockGetRepositories(),
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
  initialRequiresWorkspace = true,
  onRequiresWorkspaceChange,
  visible = true,
}: {
  onSelectorOpenChange: (open: boolean) => void
  initialRequiresWorkspace?: boolean
  onRequiresWorkspaceChange?: (requiresWorkspace: boolean) => void
  visible?: boolean
}) {
  const [selectedRepo, setSelectedRepo] = React.useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = React.useState<GitBranch | null>(null)
  const [requiresWorkspace, setRequiresWorkspace] = React.useState(initialRequiresWorkspace)

  if (!visible) return null

  return (
    <MobileRepositorySelector
      selectedRepo={selectedRepo}
      handleRepoChange={setSelectedRepo}
      selectedBranch={selectedBranch}
      handleBranchChange={setSelectedBranch}
      disabled={false}
      onSelectorOpenChange={onSelectorOpenChange}
      requiresWorkspace={requiresWorkspace}
      onRequiresWorkspaceChange={value => {
        setRequiresWorkspace(value)
        onRequiresWorkspaceChange?.(value)
      }}
    />
  )
}

async function openRepositorySelector() {
  const trigger = screen.getByTestId('mobile-repository-selector-trigger')
  await waitFor(() => expect(trigger).toBeEnabled())
  fireEvent.click(trigger)
}

describe('mobile repository and branch cascade', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetBranches.mockResolvedValue([mockBranch])
    mockGetRepositories.mockResolvedValue([mockRepo])
    mockGetLastRepo.mockReturnValue(null)
  })

  it('selects repository and branch inside one drawer', async () => {
    const onSelectorOpenChange = jest.fn()

    render(<WorkspaceSelectorHarness onSelectorOpenChange={onSelectorOpenChange} />)

    await openRepositorySelector()

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

  it('enables an optional workspace when selecting a repository and clears both selections', async () => {
    const onRequiresWorkspaceChange = jest.fn()
    const onSelectorOpenChange = jest.fn()
    mockGetLastRepo.mockReturnValue({ repoId: mockRepo.git_repo_id, repoName: mockRepo.git_repo })

    const { rerender } = render(
      <WorkspaceSelectorHarness
        initialRequiresWorkspace={false}
        onRequiresWorkspaceChange={onRequiresWorkspaceChange}
        onSelectorOpenChange={onSelectorOpenChange}
      />
    )

    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent('无需仓库')
    await openRepositorySelector()
    expect(screen.queryByTestId('mobile-workspace-clear-selection')).not.toBeInTheDocument()
    expect(mockGetBranches).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mobile-repository-option'))

    expect(onRequiresWorkspaceChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(await screen.findByTestId('mobile-branch-option'))
    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent(
      'wecode-ai/Wegent · main'
    )

    fireEvent.click(screen.getByTestId('mobile-repository-selector-trigger'))
    fireEvent.click(screen.getByTestId('mobile-workspace-clear-selection'))

    expect(onRequiresWorkspaceChange).toHaveBeenLastCalledWith(false)
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByTestId('mobile-repository-selector-drawer')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent('无需仓库')

    rerender(
      <WorkspaceSelectorHarness visible={false} onSelectorOpenChange={onSelectorOpenChange} />
    )
    rerender(<WorkspaceSelectorHarness onSelectorOpenChange={onSelectorOpenChange} />)
    await openRepositorySelector()
    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent('无需仓库')
    expect(mockGetBranches).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('mobile-repository-option'))
    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByTestId('mobile-branch-option'))
    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent(
      'wecode-ai/Wegent · main'
    )
  })

  it('allows opting out before selecting a required repository', async () => {
    const onRequiresWorkspaceChange = jest.fn()
    render(
      <WorkspaceSelectorHarness
        onRequiresWorkspaceChange={onRequiresWorkspaceChange}
        onSelectorOpenChange={jest.fn()}
      />
    )

    await openRepositorySelector()
    fireEvent.click(screen.getByTestId('mobile-workspace-clear-selection'))

    expect(onRequiresWorkspaceChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId('mobile-repository-selector-trigger')).toHaveTextContent('无需仓库')
  })

  it('keeps an existing task workspace read-only', async () => {
    const handleRepoChange = jest.fn()
    const handleBranchChange = jest.fn()
    render(
      <MobileRepositorySelector
        selectedRepo={mockRepo}
        selectedBranch={mockBranch}
        handleRepoChange={handleRepoChange}
        handleBranchChange={handleBranchChange}
        disabled
      />
    )

    expect(screen.getByTestId('mobile-repository-selector-trigger')).toBeDisabled()
    fireEvent.click(screen.getByTestId('mobile-repository-selector-trigger'))
    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledWith(mockRepo))

    expect(screen.queryByTestId('mobile-repository-selector-drawer')).not.toBeInTheDocument()
    expect(handleRepoChange).not.toHaveBeenCalled()
    expect(handleBranchChange).not.toHaveBeenCalled()
  })
})
