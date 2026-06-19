// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { ChatPageDesktop } from '@/app/(tasks)/chat/ChatPageDesktop'

let mockSearchParams = new URLSearchParams()
let mockRuntimeConfig = {
  weworkCodeUrl: '',
}
const chatAreaProps: Record<string, unknown>[] = []

// Mock window.matchMedia for useIsDesktop hook
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 1024px)', // Simulate desktop screen
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
})

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => mockSearchParams.get(key),
  }),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => mockRuntimeConfig,
}))

jest.mock('@/features/tasks/service/teamService', () => ({
  teamService: {
    useTeams: () => ({
      teams: [],
      isTeamsLoading: false,
      refreshTeams: jest.fn().mockResolvedValue([]),
    }),
  },
}))

jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: ({ children }: { children?: ReactNode }) => (
    <div>
      <div>top-navigation</div>
      <div>{children}</div>
    </div>
  ),
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  TaskSidebar: () => <div>task-sidebar</div>,
  ResizableSidebar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsedSidebarButtons: () => <div>collapsed-sidebar-buttons</div>,
  SearchDialog: () => <div>search-dialog</div>,
}))

jest.mock('@/features/layout/GithubStarButton', () => ({
  GithubStarButton: () => <div>github-star</div>,
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: null }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [],
    isTeamsLoading: false,
    refreshTeams: jest.fn().mockResolvedValue([]),
    addTeam: jest.fn(),
  }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    selectedDeviceId: null,
    devices: [],
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    refreshTasks: jest.fn(),
    selectedTask: { id: 42 },
    selectedTaskDetail: {
      id: 42,
      title: 'Task 42',
      status: 'RUNNING',
      team: {
        agent_type: 'chat',
        bots: [],
      },
    },
    taskState: null,
    selectTask: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/hooks/useSearchShortcut', () => ({
  useSearchShortcut: () => ({
    shortcutDisplayText: 'Ctrl+K',
  }),
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: (props: Record<string, unknown>) => {
    chatAreaProps.push(props)
    return <div>chat-area</div>
  },
}))

jest.mock('@/features/tasks/components/group-chat', () => ({
  CreateGroupChatDialog: () => <div>create-group-chat-dialog</div>,
}))

// Mock EnhancedMarkdown and other ESM-heavy components to avoid Jest ESM issues
jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => (
    <div data-testid="enhanced-markdown">{children}</div>
  ),
  CodeBlock: ({ children }: { children?: string }) => (
    <pre data-testid="code-block">{children}</pre>
  ),
}))

jest.mock('@/features/tasks/components/message', () => ({
  MessageBubble: ({ content }: { content?: string }) => (
    <div data-testid="message-bubble">{content}</div>
  ),
  MessageSkeleton: () => <div data-testid="message-skeleton">Loading...</div>,
  WelcomeMessage: () => <div data-testid="welcome-message">Welcome</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/remote-workspace', () => ({
  RemoteWorkspaceEntry: ({
    taskId,
    forceDisabled,
  }: {
    taskId?: number | null
    forceDisabled?: boolean
  }) => (
    <div data-testid="remote-workspace-entry">{`${String(taskId)}:${String(!!forceDisabled)}`}</div>
  ),
}))

describe('ChatPageDesktop remote workspace integration', () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams()
    mockRuntimeConfig = { weworkCodeUrl: '' }
    chatAreaProps.length = 0
  })

  test('chat desktop renders remote workspace entry in top nav when task selected', () => {
    render(<ChatPageDesktop />)

    expect(screen.getByTestId('remote-workspace-entry')).toHaveTextContent('42:false')
    expect(screen.queryByText('search-dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('create-group-chat-dialog')).not.toBeInTheDocument()
  })

  test('agent=code query enables code task behavior in chat', () => {
    mockSearchParams = new URLSearchParams('agent=code')

    render(<ChatPageDesktop />)

    expect(chatAreaProps[0]).toMatchObject({
      taskType: 'code',
      teamModeFilter: 'code',
      showRepositorySelector: true,
    })
  })

  test('configured Wework URL lets chat show chat and code agents together', () => {
    mockRuntimeConfig = { weworkCodeUrl: 'https://wework.example.com/coding' }

    render(<ChatPageDesktop />)

    expect(chatAreaProps[0]).toMatchObject({
      taskType: 'chat',
      teamModeFilter: 'all',
      showRepositorySelector: true,
    })
  })
})
