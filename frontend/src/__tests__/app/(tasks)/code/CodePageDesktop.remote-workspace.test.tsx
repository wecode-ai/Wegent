// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { CodePageDesktop } from '@/app/(tasks)/code/CodePageDesktop'

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === 'taskId' ? '84' : null),
  }),
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

jest.mock('@/features/layout/WorkbenchToggle', () => ({
  __esModule: true,
  default: () => <div>workbench-toggle</div>,
}))

jest.mock('@/features/tasks/components/input', () => ({
  OpenMenu: () => <div>open-menu</div>,
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

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTaskDetail: { id: 84, title: 'Task 84', status: 'RUNNING' },
    setSelectedTask: jest.fn(),
    refreshTasks: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    clearAllStreams: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({
    state: null,
  }),
}))

jest.mock('@/utils/openLinks', () => ({
  calculateOpenLinks: () => [],
}))

jest.mock('@/features/tasks/hooks/useSearchShortcut', () => ({
  useSearchShortcut: () => ({
    shortcutDisplayText: 'Ctrl+K',
  }),
}))

jest.mock('@/features/tasks/components', () => ({
  Workbench: () => <div>workbench</div>,
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: () => <div>chat-area</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/remote-workspace', () => ({
  RemoteWorkspaceEntry: ({ taskId }: { taskId?: number | null }) => (
    <div data-testid="remote-workspace-entry">{String(taskId)}</div>
  ),
}))

describe('CodePageDesktop remote workspace integration', () => {
  test('code desktop renders remote workspace entry in top nav when task selected', () => {
    render(<CodePageDesktop />)

    expect(screen.getByTestId('remote-workspace-entry')).toHaveTextContent('84')
  })
})
