// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import ChatInput from '@/features/tasks/components/input/ChatInput'
import {
  buildTaskMentionCandidates,
  default as MentionAutocomplete,
} from '@/features/tasks/components/chat/MentionAutocomplete'
import { taskApis } from '@/apis/tasks'
import type { Task, Team } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      preferences: {
        send_key: 'enter',
      },
    },
  }),
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/settings/components/teams/TeamIconDisplay', () => ({
  TeamIconDisplay: () => <span data-testid="team-icon" />,
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    searchTasks: jest.fn().mockResolvedValue({ total: 0, items: [] }),
  },
}))

const makeTask = (id: number, title: string, updatedAt: string): Task =>
  ({
    id,
    title,
    prompt: `${title} prompt`,
    updated_at: updatedAt,
    created_at: updatedAt,
  }) as Task

const reviewTeam = {
  id: 12,
  name: 'Review agent',
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '',
  updated_at: '',
} satisfies Team

describe('task conversation mentions', () => {
  beforeAll(() => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      }),
    })
  })

  it('orders newer tasks first and excludes the current task', () => {
    const tasks = [
      makeTask(1, 'Oldest task', '2026-01-01T00:00:00Z'),
      makeTask(2, 'Current task', '2026-03-01T00:00:00Z'),
      makeTask(3, 'Newest task', '2026-04-01T00:00:00Z'),
    ]

    expect(buildTaskMentionCandidates(tasks, '', 2).map(task => task.id)).toEqual([3, 1])
  })

  it('renders task rows in recency order', () => {
    const tasks = [
      makeTask(1, 'Older task', '2026-01-01T00:00:00Z'),
      makeTask(2, 'Newer task', '2026-04-01T00:00:00Z'),
    ]

    render(
      <MentionAutocomplete
        team={null}
        tasks={tasks}
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 0, left: 0 }}
      />
    )

    const rows = screen.getAllByTestId(/mention-task-option-/)
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
      'mention-task-option-2',
      'mention-task-option-1',
    ])
  })

  it('keeps the group agent as the default @ selection', () => {
    const tasks = [makeTask(1, 'Previous task', '2026-04-01T00:00:00Z')]

    render(
      <MentionAutocomplete
        team={reviewTeam}
        tasks={tasks}
        showTeamMention
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 0, left: 0 }}
      />
    )

    const rows = screen.getAllByTestId(/^mention-(agent|task)-option-/)
    expect(rows[0]).toHaveAttribute('data-testid', 'mention-agent-option-12')
  })

  it('searches older tasks outside the loaded task list', async () => {
    const task = makeTask(9, 'Deep historical task', '2025-12-01T00:00:00Z')
    const searchTasks = jest.mocked(taskApis.searchTasks)
    searchTasks.mockResolvedValueOnce({ total: 1, items: [task] })

    render(
      <MentionAutocomplete
        team={null}
        query="historical"
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 0, left: 0 }}
      />
    )

    expect(await screen.findByTestId('mention-task-option-9')).toBeInTheDocument()
    expect(searchTasks).toHaveBeenCalledWith('historical', { limit: 20 })
  })

  it('clamps the menu height and shifts it down when it would overflow the viewport top', () => {
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -200,
      width: 320,
      height: 320,
      top: -200,
      right: 320,
      bottom: 120,
      left: 0,
      toJSON: () => ({}),
    })

    try {
      render(
        <MentionAutocomplete
          team={null}
          tasks={[makeTask(1, 'Previous task', '2026-04-01T00:00:00Z')]}
          enableTaskMentions
          onSelect={jest.fn()}
          onSelectTask={jest.fn()}
          onClose={jest.fn()}
          position={{ top: 0, left: 0 }}
        />
      )

      const menu = screen.getByTestId('mention-autocomplete')
      expect(menu.style.maxHeight).toBe('160px')
      expect(menu.style.transform).toBe('translateY(208px)')
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('removes the @ query and selects a task from the composer', async () => {
    const task = makeTask(7, 'Old handoff task', '2026-04-01T00:00:00Z')
    const setMessage = jest.fn()
    const onSelectConversation = jest.fn()

    render(
      <ChatInput
        message=""
        setMessage={setMessage}
        handleSendMessage={jest.fn()}
        isLoading={false}
        mentionTasks={[task]}
        enableTaskMentions
        onSelectConversation={onSelectConversation}
      />
    )

    const input = screen.getByTestId('message-input')
    const placeCaretAtEnd = () => {
      input.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    input.textContent = '@'
    placeCaretAtEnd()
    fireEvent.input(input)
    input.textContent = '@old'
    placeCaretAtEnd()
    fireEvent.input(input)

    const option = await screen.findByTestId('mention-task-option-7')
    fireEvent.click(option)

    await waitFor(() => expect(onSelectConversation).toHaveBeenCalledWith(task))
    expect(setMessage).toHaveBeenLastCalledWith('')
  })
})
