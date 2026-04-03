// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'

import TaskSidebar, { SIDEBAR_NAV_CONFIG } from '@/features/tasks/components/sidebar/TaskSidebar'

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    // Use a plain img in tests to avoid Next.js image runtime requirements.
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={props.alt} />
  },
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
  }),
}))

jest.mock('@/config/paths', () => ({
  paths: {
    feed: { getHref: () => '/feed' },
    code: { getHref: () => '/code' },
    wiki: { getHref: () => '/knowledge' },
    devices: { getHref: () => '/devices' },
    inbox: { getHref: () => '/inbox' },
    chat: { getHref: () => '/chat' },
  },
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    tasks: [],
    groupTasks: [],
    personalTasks: [],
    loadMore: jest.fn(),
    loadMoreGroupTasks: jest.fn(),
    loadMorePersonalTasks: jest.fn(),
    loadingMore: false,
    loadingMoreGroupTasks: false,
    loadingMorePersonalTasks: false,
    hasMoreGroupTasks: false,
    hasMorePersonalTasks: false,
    searchTerm: '',
    setSearchTerm: jest.fn(),
    searchTasks: jest.fn(),
    isSearching: false,
    isSearchResult: false,
    getUnreadCount: () => 0,
    markAllTasksAsViewed: jest.fn(),
    viewStatusVersion: 0,
    setSelectedTask: jest.fn(),
    isRefreshing: false,
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    clearAllStreams: jest.fn(),
  }),
}))

jest.mock('@/features/inbox', () => ({
  useInboxUnreadCount: () => ({
    unreadCount: 0,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/layout/MobileSidebar', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/layout/components/UserFloatingMenu', () => ({
  UserFloatingMenu: () => <div>user-floating-menu</div>,
}))

jest.mock('@/features/tasks/components/sidebar/HistoryManageDialog', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/sidebar/TaskListSection', () => ({
  __esModule: true,
  default: () => <div>task-list-section</div>,
}))

jest.mock('@/features/projects', () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TaskDndProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useProjectContext: () => ({
    projectTaskIds: new Set(),
    projects: [],
  }),
  DroppableHistory: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ProjectSection: () => <div>project-section</div>,
}))

describe('TaskSidebar scroll structure', () => {
  afterEach(() => {
    SIDEBAR_NAV_CONFIG.keepSecondaryNavFixed = true
  })

  it('keeps secondary navigation fixed by default', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const scrollContainer = screen.getAllByTestId('task-sidebar-scroll-container')[0]
    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]
    const scrollableSection = screen.getAllByTestId('task-sidebar-scroll-content')[0]

    expect(scrollContainer).toContainElement(fixedSection)
    expect(scrollContainer).toContainElement(scrollableSection)

    expect(
      within(fixedSection).getByRole('button', { name: /common:tasks\.new_conversation/ })
    ).toBeInTheDocument()
    expect(within(fixedSection).getByText('common:navigation.flow')).toBeInTheDocument()
    expect(within(fixedSection).getByText('common:navigation.code')).toBeInTheDocument()
    expect(within(fixedSection).getByText('common:navigation.wiki')).toBeInTheDocument()
    expect(within(fixedSection).getByText('devices:my_devices')).toBeInTheDocument()
    expect(within(fixedSection).getByText('common:navigation.inbox')).toBeInTheDocument()

    expect(within(scrollableSection).queryByText('common:navigation.wiki')).not.toBeInTheDocument()
    expect(within(scrollableSection).queryByText('devices:my_devices')).not.toBeInTheDocument()
    expect(within(scrollableSection).queryByText('common:navigation.inbox')).not.toBeInTheDocument()
  })

  it('moves secondary navigation back into the scrollable area when the config is disabled', () => {
    SIDEBAR_NAV_CONFIG.keepSecondaryNavFixed = false

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]
    const scrollableSection = screen.getAllByTestId('task-sidebar-scroll-content')[0]

    expect(within(fixedSection).queryByText('common:navigation.wiki')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('devices:my_devices')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('common:navigation.inbox')).not.toBeInTheDocument()

    expect(within(scrollableSection).getByText('common:navigation.wiki')).toBeInTheDocument()
    expect(within(scrollableSection).getByText('devices:my_devices')).toBeInTheDocument()
    expect(within(scrollableSection).getByText('common:navigation.inbox')).toBeInTheDocument()
  })

  it('scrolls the sidebar when wheeling over the fixed section', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const scrollContainer = screen.getAllByTestId('task-sidebar-scroll-container')[0]
    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]

    Object.defineProperty(scrollContainer, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })

    fireEvent.wheel(fixedSection, { deltaY: 240 })

    expect(scrollContainer.scrollTop).toBe(240)
  })

  it('keeps the gap between fixed and scrollable navigation buttons consistent', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]
    const scrollableSection = screen.getAllByTestId('task-sidebar-scroll-content')[0]
    const fixedNavWrapper = fixedSection.querySelector('[data-tour="mode-toggle"]')
    const scrollableNavWrapper = scrollableSection.firstElementChild
    const fixedNavChildren = fixedNavWrapper?.children ?? []

    expect(fixedNavWrapper).not.toHaveClass('pb-0.5')
    expect(Array.from(fixedNavChildren).some(child => child.classList.contains('pt-0.5'))).toBe(
      false
    )
    expect(scrollableNavWrapper).not.toHaveClass('pt-3')
    expect(scrollableNavWrapper).not.toHaveClass('pt-0.5')
  })

  it('keeps the user menu outside of the scroll container', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const scrollContainer = screen.getAllByTestId('task-sidebar-scroll-container')[0]
    const settingsLink = screen
      .getAllByText('user-floating-menu')[0]
      .closest('[data-tour="settings-link"]') as HTMLElement | null

    expect(settingsLink).toBeInTheDocument()
    expect(scrollContainer).not.toContainElement(settingsLink)
  })
})
