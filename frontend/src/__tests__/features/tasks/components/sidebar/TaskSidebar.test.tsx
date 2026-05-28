// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'

import TaskSidebar, { SIDEBAR_NAV_CONFIG } from '@/features/tasks/components/sidebar/TaskSidebar'
import type { Task } from '@/types/api'

const createTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 1,
  title: overrides.title ?? 'Task',
  team_id: 1,
  git_url: '',
  git_repo: '',
  git_repo_id: 0,
  git_domain: '',
  branch_name: '',
  prompt: '',
  status: 'COMPLETED',
  progress: 100,
  batch: 0,
  result: {},
  error_message: '',
  user_id: 1,
  user_name: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const mockTaskContext = {
  tasks: [] as Task[],
  groupTasks: [] as Task[],
  personalTasks: [] as Task[],
  loadMore: jest.fn(),
  loadAllGroupTasks: jest.fn(),
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
}

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
    resourceLibrary: { getHref: () => '/resource-library' },
  },
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => mockTaskContext,
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
  default: ({
    title,
    titleIcon,
    titleClassName,
    initialVisibleCount,
    tasks,
  }: {
    title?: string
    titleIcon?: React.ReactNode
    titleClassName?: string
    initialVisibleCount?: number
    tasks: Task[]
  }) => (
    <section
      data-testid="task-list-section"
      data-initial-visible-count={initialVisibleCount ?? ''}
      data-title-class-name={titleClassName ?? ''}
    >
      {title && (
        <h4>
          {titleIcon}
          {title}
        </h4>
      )}
      {tasks.map(task => (
        <div key={task.id}>{task.title}</div>
      ))}
    </section>
  ),
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
  beforeEach(() => {
    Object.assign(mockTaskContext, {
      tasks: [],
      groupTasks: [],
      personalTasks: [],
      loadMore: jest.fn(),
      loadAllGroupTasks: jest.fn(),
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
    })
  })

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
    expect(within(fixedSection).getByText('common:navigation.more')).toBeInTheDocument()
    expect(within(fixedSection).getByLabelText('More navigation')).toHaveClass('lucide-layout-grid')
    expect(
      within(fixedSection).queryByTestId('resource-library-sidebar-button')
    ).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('devices:my_devices')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('common:navigation.inbox')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('resource-library:title')).not.toBeInTheDocument()

    expect(within(scrollableSection).queryByText('common:navigation.wiki')).not.toBeInTheDocument()
    expect(within(scrollableSection).queryByText('devices:my_devices')).not.toBeInTheDocument()
    expect(within(scrollableSection).queryByText('common:navigation.inbox')).not.toBeInTheDocument()
  })

  it('shows secondary navigation in a right-side flyout from more', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]

    expect(screen.queryByTestId('task-sidebar-more-flyout')).not.toBeInTheDocument()

    fireEvent.mouseEnter(within(fixedSection).getByTestId('task-sidebar-more-button'))

    const flyout = screen.getByTestId('task-sidebar-more-flyout')
    expect(within(flyout).getByText('resource-library:title')).toBeInTheDocument()
    expect(within(flyout).getByText('devices:my_devices')).toBeInTheDocument()
    expect(within(flyout).getByText('common:navigation.inbox')).toBeInTheDocument()
  })

  it('moves secondary navigation back into the scrollable area when the config is disabled', () => {
    SIDEBAR_NAV_CONFIG.keepSecondaryNavFixed = false

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const fixedSection = screen.getAllByTestId('task-sidebar-fixed-section')[0]
    const scrollableSection = screen.getAllByTestId('task-sidebar-scroll-content')[0]

    expect(within(fixedSection).getByText('common:navigation.wiki')).toBeInTheDocument()
    expect(within(fixedSection).queryByText('resource-library:title')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('devices:my_devices')).not.toBeInTheDocument()
    expect(within(fixedSection).queryByText('common:navigation.inbox')).not.toBeInTheDocument()

    expect(within(scrollableSection).getByText('resource-library:title')).toBeInTheDocument()
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

  it('uses compact vertical spacing in the fixed navigation section', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const logoSection = screen.getAllByTestId('task-sidebar-logo-section')[0]
    const newConversationButton = screen
      .getAllByText('common:tasks.new_conversation')[0]
      .closest('button')
    const automationButton = screen.getAllByTestId('task-sidebar-nav-flow-button')[0]
    const moreButton = screen.getAllByTestId('task-sidebar-more-button')[0]

    expect(logoSection).toHaveClass('pt-2', 'pb-3')
    expect(newConversationButton).toHaveClass('h-11', 'min-w-[44px]')
    expect(automationButton).toHaveClass('h-11', 'min-w-[44px]')
    expect(moreButton).toHaveClass('h-11', 'min-w-[44px]')
    expect(newConversationButton).toHaveAttribute('data-testid', 'new-agent-button')
  })

  it('uses theme-aware text color for inactive sidebar labels', () => {
    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const newConversationLabel = screen.getAllByText('common:tasks.new_conversation')[0]
    const automationLabel = screen.getAllByText('common:navigation.flow')[0]
    const moreLabel = screen.getAllByText('common:navigation.more')[0]

    expect(newConversationLabel).toHaveClass('text-text-primary')
    expect(automationLabel).toHaveClass('text-text-primary')
    expect(moreLabel).toHaveClass('text-text-primary')
    expect(newConversationLabel).not.toHaveClass('text-[#444746]')
    expect(automationLabel).not.toHaveClass('text-[#444746]')
    expect(moreLabel).not.toHaveClass('text-[#444746]')
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

  it('keeps group chats fixed above the user menu and collapsed into one dropdown row by default', () => {
    mockTaskContext.personalTasks = [createTask({ id: 1, title: 'Personal message' })]
    mockTaskContext.groupTasks = [
      createTask({ id: 2, title: 'Group chat message', is_group_chat: true }),
      createTask({ id: 3, title: 'Second group chat', is_group_chat: true }),
    ]
    mockTaskContext.hasMoreGroupTasks = true

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const scrollableSection = screen.getAllByTestId('task-sidebar-scroll-content')[0]
    const scrollContainer = screen.getAllByTestId('task-sidebar-scroll-container')[0]
    const groupDock = screen.getAllByTestId('task-sidebar-group-chat-dock')[0]
    const settingsLink = screen
      .getAllByText('user-floating-menu')[0]
      .closest('[data-tour="settings-link"]') as HTMLElement | null

    expect(settingsLink).toBeInTheDocument()
    expect(scrollContainer).not.toContainElement(groupDock)
    expect(groupDock.compareDocumentPosition(settingsLink as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(within(scrollableSection).getByText('Personal message')).toBeInTheDocument()
    expect(
      within(scrollableSection).queryByText('common:tasks.group_chats')
    ).not.toBeInTheDocument()
    expect(within(scrollableSection).queryByText('Group chat message')).not.toBeInTheDocument()

    const groupToggle = within(groupDock).getByTestId('task-sidebar-group-chat-toggle')
    expect(groupToggle).toHaveTextContent('common:tasks.group_chats')
    expect(groupToggle).toHaveClass('h-6', 'min-w-[44px]')
    expect(groupToggle).not.toHaveClass('h-11')
    expect(groupToggle).not.toHaveTextContent('(+2)')
    expect(within(groupToggle).getByTestId('task-sidebar-group-chat-chevron')).toHaveClass(
      'lucide-chevron-down'
    )
    expect(
      within(groupDock).queryByText(/common:tasks\.group_chats_expand/)
    ).not.toBeInTheDocument()
    expect(within(groupDock).queryByText('Group chat message')).not.toBeInTheDocument()

    fireEvent.click(groupToggle)

    expect(mockTaskContext.loadAllGroupTasks).toHaveBeenCalledTimes(1)
    expect(mockTaskContext.loadMoreGroupTasks).not.toHaveBeenCalled()
    expect(within(groupDock).getByText('Group chat message')).toBeInTheDocument()
  })

  it('renders personal history as a flat list', () => {
    const agentTask = createTask({ id: 1, title: 'Agent conversation' })
    const deviceTask = createTask({ id: 2, title: 'Device conversation' })
    mockTaskContext.personalTasks = [agentTask, deviceTask]

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const sections = screen.getAllByTestId('task-list-section')

    expect(within(sections[0]).getByText('Agent conversation')).toBeInTheDocument()
    expect(within(sections[0]).getByText('Device conversation')).toBeInTheDocument()
  })

  it('shows all loaded conversations in one personal history list', () => {
    const agentTasks = Array.from({ length: 6 }, (_, index) =>
      createTask({ id: index + 1, title: `Agent conversation ${index + 1}` })
    )
    const deviceTasks = Array.from({ length: 6 }, (_, index) =>
      createTask({ id: index + 101, title: `Device conversation ${index + 1}` })
    )
    mockTaskContext.personalTasks = [...agentTasks, ...deviceTasks]

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    const sections = screen.getAllByTestId('task-list-section')

    expect(sections[0]).toHaveAttribute('data-initial-visible-count', '')
    expect(sections[0]).toHaveAttribute('data-title-class-name', '')
    expect(within(sections[0]).getByText('Agent conversation 6')).toBeInTheDocument()
    expect(within(sections[0]).getByText('Device conversation 6')).toBeInTheDocument()
  })

  it('loads more personal history from the global load more button', () => {
    const agentTask = createTask({ id: 1, title: 'Agent conversation' })
    const loadMorePersonalTasks = jest.fn()
    mockTaskContext.personalTasks = [agentTask]
    mockTaskContext.hasMorePersonalTasks = true
    mockTaskContext.loadMorePersonalTasks = loadMorePersonalTasks

    render(
      <TaskSidebar isMobileSidebarOpen={false} setIsMobileSidebarOpen={jest.fn()} pageType="chat" />
    )

    fireEvent.click(screen.getAllByTestId('load-more-personal-tasks-button')[0])

    expect(loadMorePersonalTasks).toHaveBeenCalledTimes(1)
  })
})
