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
  taskMentionName,
} from '@/features/tasks/components/chat/MentionAutocomplete'
import { mergeTaskMentionTasks } from '@/features/tasks/components/chat/taskMentionTasks'
import { taskApis } from '@/apis/tasks'
import type { ProjectTask, Task, Team } from '@/types/api'

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

  it('includes project conversations in the empty mention candidates', () => {
    const directTask = makeTask(1, 'Standalone conversation', '2026-04-01T00:00:00Z')
    const projectTask = {
      task_id: 7,
      task_title: '云主机安装embedding',
      task_status: 'COMPLETED',
      device_id: 'cloud-device',
      is_group_chat: false,
      project_id: 2561,
      updated_at: '2026-04-02T00:00:00Z',
    } satisfies ProjectTask

    const merged = mergeTaskMentionTasks([directTask], [[projectTask]])

    expect(buildTaskMentionCandidates(merged, '', null).map(task => task.title)).toEqual([
      '云主机安装embedding',
      'Standalone conversation',
    ])
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
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    const rows = screen.getAllByTestId(/mention-task-option-/)
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
      'mention-task-option-2',
      'mention-task-option-1',
    ])
  })

  it('requests project task candidates when the task mention menu opens', () => {
    const onOpen = jest.fn()

    render(
      <MentionAutocomplete
        team={null}
        enableTaskMentions
        onOpen={onOpen}
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    expect(onOpen).toHaveBeenCalledTimes(1)
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
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    const rows = screen.getAllByTestId(/^mention-(agent|task)-option-/)
    expect(rows[0]).toHaveAttribute('data-testid', 'mention-agent-option-12')
  })

  it('moves the highlighted option with arrow keys and selects it with Enter', () => {
    const newer = makeTask(2, 'Newer task', '2026-04-02T00:00:00Z')
    const older = makeTask(1, 'Older task', '2026-04-01T00:00:00Z')
    const onSelectTask = jest.fn()

    render(
      <MentionAutocomplete
        team={null}
        tasks={[older, newer]}
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={onSelectTask}
        onClose={jest.fn()}
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    const newerRow = screen.getByTestId('mention-task-option-2')
    const olderRow = screen.getByTestId('mention-task-option-1')
    expect(newerRow).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(olderRow).toHaveAttribute('aria-selected', 'true')
    expect(olderRow.className).toContain('bg-primary/10')

    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(newerRow).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onSelectTask).toHaveBeenCalledWith(older)
  })

  it('ignores Enter while an IME composition is active', () => {
    const task = makeTask(3, 'IME task', '2026-04-01T00:00:00Z')
    const onSelectTask = jest.fn()

    render(
      <MentionAutocomplete
        team={null}
        tasks={[task]}
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={onSelectTask}
        onClose={jest.fn()}
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    fireEvent.keyDown(document, { key: 'Enter', keyCode: 229 })
    expect(onSelectTask).not.toHaveBeenCalled()
  })

  it('falls back to the task id when title and prompt are missing', () => {
    expect(taskMentionName({ id: 42, title: '', prompt: undefined } as unknown as Task)).toBe('42')
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
        position={{ top: 100, bottom: 126, left: 0 }}
      />
    )

    expect(await screen.findByTestId('mention-task-option-9')).toBeInTheDocument()
    expect(searchTasks).toHaveBeenCalledWith('historical', { limit: 20 })
  })

  it('opens below the cursor when the composer is in the upper half of the viewport', () => {
    render(
      <MentionAutocomplete
        team={null}
        tasks={[makeTask(1, 'Previous task', '2026-04-01T00:00:00Z')]}
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 100, bottom: 126, left: 20, direction: 'below' }}
      />
    )

    const menu = screen.getByTestId('mention-autocomplete')
    expect(menu).toHaveAttribute('data-direction', 'below')
    expect(menu.style.top).toBe('134px')
    expect(menu.style.maxHeight).toBe('480px')
  })

  it('flips above the cursor when there is not enough room below', () => {
    render(
      <MentionAutocomplete
        team={null}
        tasks={[makeTask(1, 'Previous task', '2026-04-01T00:00:00Z')]}
        enableTaskMentions
        onSelect={jest.fn()}
        onSelectTask={jest.fn()}
        onClose={jest.fn()}
        position={{ top: 600, bottom: 626, left: 20, direction: 'below' }}
      />
    )

    const menu = screen.getByTestId('mention-autocomplete')
    expect(menu).toHaveAttribute('data-direction', 'above')
    expect(menu.style.top).toBe('112px')
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
