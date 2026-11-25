import type { ScopedDraftStore } from '@/features/workbench/scopedDraftStore'
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { ProjectSpaceChatSidebar } from '@/features/todo/ProjectSpaceChatSidebar'
import type { CloudProject } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'

// Reuse the real TemporaryChatPanel/composer harness and its service fixtures.
interface DraftHarness {
  realComposer: boolean
  runtimeWork: { projects: unknown[]; chats: unknown[]; totalTasks: number } | null
  draftStore: ScopedDraftStore
  createTask: { mockReturnValueOnce(value: Promise<RuntimeTaskAddress | false>): unknown }
}

const project: CloudProject = {
  id: '11',
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Draft ownership',
  description: '',
  tags: [],
  project_store: 'backend' as const,
  task_provider: 'dingtalk_aitable' as const,
  provider_config: { base_id: 'base-1', table_id: 'table-1' },
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}
const address = { deviceId: 'device-1', taskId: 'new-task', workspacePath: '/chat/new' }
const nextDraft = 'Keep the next message while the conversation is created'
const instancePrefix = 'pane:project-space:backend:11:'

function conversation(taskId: string, title: string) {
  return {
    deviceId: 'device-1',
    available: true,
    workspacePath: '/chat',
    tasks: [
      {
        taskId,
        title,
        workspacePath: `/chat/${taskId}`,
        runtime: 'codex',
        runtimeHandle: { cloudProjectId: '11' },
      },
    ],
  }
}

function beginCreation(mocks: DraftHarness) {
  mocks.realComposer = true
  mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
  window.localStorage.clear()
  let complete!: (value: RuntimeTaskAddress | false) => void
  mocks.createTask.mockReturnValueOnce(
    new Promise(resolve => {
      complete = resolve
    })
  )
  const props = { project, localProjects: [], onClose: vi.fn(), startNew: true }
  const view = render(<ProjectSpaceChatSidebar {...props} />)
  const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  return { complete, props, view, editor }
}

async function typeWhileCreating(editor: HTMLElement & { value: string }) {
  await act(async () => {
    editor.value = 'First request'
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
  })
  expect(editor).toHaveAttribute('contenteditable', 'true')
  await act(async () => {
    editor.value = nextDraft
  })
  expect(editor).toHaveValue(nextDraft)
}

function selectConversation(title: string) {
  fireEvent.click(screen.getByTestId('project-space-chat-menu'))
  fireEvent.click(within(screen.getByTestId('project-space-chat-menu-list')).getByText(title))
}

export function registerProjectSpaceChatDraftTests(mocks: DraftHarness) {
  it.each([false, true])(
    'keeps the next project draft through address binding (published=%s)',
    async published => {
      const { complete, props, view, editor } = beginCreation(mocks)
      vi.useFakeTimers()
      try {
        await typeWhileCreating(editor)
        expect(mocks.createTask).toHaveBeenCalledOnce()
        if (published) await act(() => vi.advanceTimersByTimeAsync(301))
        await act(async () => complete(address))
        expect(screen.getByTestId('chat-message-input')).toBe(editor)
        expect(editor).toHaveValue(nextDraft)
        await act(() => vi.advanceTimersByTimeAsync(301))
        expect(mocks.draftStore.exportInputs()[`${instancePrefix}device-1:new-task`]).toBe(
          nextDraft
        )
        expect(mocks.draftStore.exportInputs()[`${instancePrefix}new`]).toBeUndefined()

        mocks.runtimeWork = {
          projects: [],
          chats: [
            conversation('new-task', 'Created conversation'),
            conversation('other-task', 'Other conversation'),
          ],
          totalTasks: 2,
        }
        view.rerender(<ProjectSpaceChatSidebar {...props} />)
        expect(editor).toHaveValue(nextDraft)
        selectConversation('Other conversation')
        const other = screen.getByTestId('chat-message-input') as typeof editor
        expect(other).toHaveValue('')
        await act(async () => {
          other.value = 'Other draft'
        })
        await act(() => vi.advanceTimersByTimeAsync(301))
        selectConversation('Created conversation')
        expect(screen.getByTestId('chat-message-input')).toHaveValue(nextDraft)
        fireEvent.click(screen.getByTestId('project-space-chat-new'))
        expect(screen.getByTestId('chat-message-input')).toHaveValue('')
        expect(mocks.draftStore.exportInputs()[`${instancePrefix}device-1:other-task`]).toBe(
          'Other draft'
        )
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps a newer project draft when conversation creation fails', async () => {
    const { complete, editor } = beginCreation(mocks)
    vi.useFakeTimers()
    try {
      await typeWhileCreating(editor)
      await act(async () => complete(false))
      expect(editor).toHaveValue(nextDraft)
      await act(() => vi.advanceTimersByTimeAsync(301))
      expect(mocks.draftStore.exportInputs()[`${instancePrefix}new`]).toBe(nextDraft)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['conversation', 'project'] as const)(
    'rejects a late draft handoff after switching %s',
    async target => {
      const { complete, props, view, editor } = beginCreation(mocks)
      vi.useFakeTimers()
      try {
        mocks.runtimeWork = {
          projects: [],
          chats: [conversation('other-task', 'Other conversation')],
          totalTasks: 1,
        }
        view.rerender(<ProjectSpaceChatSidebar {...props} />)
        await typeWhileCreating(editor)
        if (target === 'project') {
          view.rerender(<ProjectSpaceChatSidebar {...props} project={{ ...project, id: '12' }} />)
        } else {
          selectConversation('Other conversation')
        }
        const activeEditor = screen.getByTestId('chat-message-input') as typeof editor
        await act(async () => {
          activeEditor.value = 'Keep the active draft'
        })
        await act(async () => complete(address))
        expect(screen.getByTestId('chat-message-input')).toBe(activeEditor)
        expect(activeEditor).toHaveValue('Keep the active draft')
        expect(
          mocks.draftStore.exportInputs()[`${instancePrefix}device-1:new-task`]
        ).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    }
  )
}
