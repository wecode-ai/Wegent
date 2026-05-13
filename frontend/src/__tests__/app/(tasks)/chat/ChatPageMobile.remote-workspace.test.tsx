// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { ChatPageMobile } from '@/app/(tasks)/chat/ChatPageMobile'

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: () => null,
  }),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
  }),
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
  SearchDialog: () => <div>search-dialog</div>,
}))

jest.mock('@/features/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div>theme-toggle</div>,
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

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    refreshTasks: jest.fn(),
    selectedTaskDetail: {
      id: 42,
      title: 'Task 42',
      status: 'RUNNING',
      team: {
        agent_type: 'chat',
        bots: [],
      },
    },
    setSelectedTask: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    clearAllStreams: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/hooks/useSearchShortcut', () => ({
  useSearchShortcut: () => ({
    shortcutDisplayText: 'Ctrl+K',
  }),
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: () => <div>chat-area</div>,
}))

jest.mock('@/features/tasks/components/group-chat', () => ({
  CreateGroupChatDialog: () => <div>create-group-chat-dialog</div>,
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(() => new Promise(() => {})),
}))

jest.mock('@/features/settings/services/bots', () => ({
  fetchBotsList: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/features/settings/components/TeamEditDialog', () => ({
  __esModule: true,
  default: () => <div>team-edit-dialog</div>,
}))

jest.mock('@/features/tasks/hooks/useTeamEditExtension', () => ({
  useTeamEditExtension: () => ({}),
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

describe('ChatPageMobile remote workspace integration', () => {
  test('chat mobile renders remote workspace entry in top nav when task selected', () => {
    render(<ChatPageMobile />)

    expect(screen.getByTestId('remote-workspace-entry')).toHaveTextContent('42')
  })
})
