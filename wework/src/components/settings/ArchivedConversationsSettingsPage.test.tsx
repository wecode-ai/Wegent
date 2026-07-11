import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import { resetArchivedConversationsSettingsStateForTest } from './archivedConversationsSettingsState'
import { createLocalAppServices } from '@/api/local/localServices'
import '@/i18n'
import type { ArchivedConversationItem } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: vi.fn(),
}))

const createLocalAppServicesMock = vi.mocked(createLocalAppServices)

const archivedItem: ArchivedConversationItem = {
  id: 'conversation-1',
  taskId: 'codex-1',
  title: 'Greet user',
  projectKey: 'project-1',
  projectName: 'weekly-mail',
  workspacePath: '/Users/crystal/dev/git/weekly-report',
  deviceId: 'device-1',
  deviceAddress: '10.201.3.200:1420',
  source: 'local',
  createdAt: '2026-06-24T10:00:00Z',
  updatedAt: '2026-06-24T10:30:00Z',
}

function archivedItemAt(index: number): ArchivedConversationItem {
  return {
    ...archivedItem,
    id: `conversation-${index}`,
    taskId: `codex-${index}`,
    title: `Archived conversation ${index}`,
  }
}

describe('ArchivedConversationsSettingsPage', () => {
  const listArchivedConversations = vi.fn()
  const deleteArchivedConversation = vi.fn()
  const deleteArchivedConversationsBulk = vi.fn()
  const previewArchivedConversationCleanup = vi.fn()
  const cleanupArchivedConversations = vi.fn()
  const unarchiveConversation = vi.fn()

  beforeEach(() => {
    createLocalAppServicesMock.mockClear()
    resetArchivedConversationsSettingsStateForTest()
    listArchivedConversations.mockResolvedValue({
      items: [archivedItem],
      projectGroups: [],
      total: 1,
    })
    deleteArchivedConversation.mockResolvedValue({})
    deleteArchivedConversationsBulk.mockResolvedValue({ results: [] })
    previewArchivedConversationCleanup.mockResolvedValue({
      success: true,
      deleted: false,
      taskCount: 1,
      targetCount: 2,
      cleanableCount: 2,
      skippedCount: 0,
      errorCount: 0,
      bytes: 1536,
      results: [],
    })
    cleanupArchivedConversations.mockResolvedValue({
      success: true,
      deleted: true,
      taskCount: 1,
      targetCount: 2,
      cleanableCount: 2,
      skippedCount: 0,
      errorCount: 0,
      bytes: 1536,
      results: [],
    })
    unarchiveConversation.mockResolvedValue({})
    createLocalAppServicesMock.mockReturnValue({
      runtimeWorkApi: {
        listArchivedConversations,
        deleteArchivedConversation,
        deleteArchivedConversationsBulk,
        previewArchivedConversationCleanup,
        cleanupArchivedConversations,
        unarchiveConversation,
      },
    } as unknown as ReturnType<typeof createLocalAppServices>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('opens an in-app delete confirmation dialog instead of the browser confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<ArchivedConversationsSettingsPage />)

    await screen.findAllByText('Greet user')

    await userEvent.click(screen.getByTestId('archived-delete-button-device-1-codex-1'))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('archived-delete-confirm-dialog')).toHaveTextContent(
      '删除已归档聊天?'
    )
    expect(screen.getByTestId('archived-delete-confirm-dialog')).toHaveTextContent(
      '这将永久删除已归档聊天'
    )

    await userEvent.click(screen.getByTestId('archived-delete-confirm-dialog-confirm-button'))

    await waitFor(() => {
      expect(deleteArchivedConversation).toHaveBeenCalledWith({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-1',
      })
    })
    expect(listArchivedConversations).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Greet user')).not.toBeInTheDocument()
    expect(createLocalAppServices).toHaveBeenCalledTimes(1)
  })

  test('uses the injected hybrid API and offers View now after unarchiving', async () => {
    const onRefreshWorkLists = vi.fn().mockResolvedValue(undefined)
    const onOpenRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const onLeaveSettings = vi.fn()
    const api = {
      listArchivedConversations,
      deleteArchivedConversation,
      deleteArchivedConversationsBulk,
      previewArchivedConversationCleanup,
      cleanupArchivedConversations,
      unarchiveConversation,
    } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>

    render(
      <ArchivedConversationsSettingsPage
        api={api}
        onRefreshWorkLists={onRefreshWorkLists}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onLeaveSettings={onLeaveSettings}
      />
    )

    await screen.findByText('Greet user')
    await userEvent.click(screen.getByTestId('archived-unarchive-button-device-1-codex-1'))

    await waitFor(() => {
      expect(unarchiveConversation).toHaveBeenCalledWith({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-1',
      })
    })
    expect(createLocalAppServices).not.toHaveBeenCalled()
    expect(await screen.findByTestId('archived-view-now-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('archived-view-now-button'))
    await waitFor(() => expect(onOpenRuntimeTask).toHaveBeenCalled())
    expect(onRefreshWorkLists).toHaveBeenCalled()
    expect(onLeaveSettings).toHaveBeenCalled()
  })

  test('scans and cleans archived conversation leftover files manually', async () => {
    render(<ArchivedConversationsSettingsPage />)

    await screen.findAllByText('Greet user')

    await userEvent.click(screen.getByTestId('archived-cleanup-preview-button'))

    await waitFor(() => {
      expect(previewArchivedConversationCleanup).toHaveBeenCalledWith({
        items: [
          {
            deviceId: 'device-1',
            workspacePath: '/Users/crystal/dev/git/weekly-report',
            taskId: 'codex-1',
          },
        ],
      })
    })
    expect(screen.getByTestId('archived-cleanup-summary')).toHaveTextContent('2')
    expect(screen.getByTestId('archived-cleanup-summary')).toHaveTextContent('1.5 KB')

    await userEvent.click(screen.getByTestId('archived-cleanup-button'))

    await waitFor(() => {
      expect(cleanupArchivedConversations).toHaveBeenCalledWith({
        items: [
          {
            deviceId: 'device-1',
            workspacePath: '/Users/crystal/dev/git/weekly-report',
            taskId: 'codex-1',
          },
        ],
      })
    })
  })

  test('deletes archived conversations in batches with visible progress', async () => {
    const archivedItems = Array.from({ length: 6 }, (_, index) => archivedItemAt(index + 1))
    let resolveSecondBatch: (() => void) | undefined
    listArchivedConversations
      .mockResolvedValueOnce({
        items: archivedItems,
        projectGroups: [],
        total: archivedItems.length,
      })
      .mockResolvedValue({
        items: [],
        projectGroups: [],
        total: 0,
      })
    deleteArchivedConversationsBulk
      .mockResolvedValueOnce({
        results: archivedItems.slice(0, 5).map(item => ({
          taskId: item.taskId,
          deleted: true,
        })),
      })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveSecondBatch = () =>
              resolve({
                results: archivedItems.slice(5).map(item => ({
                  taskId: item.taskId,
                  deleted: true,
                })),
              })
          })
      )

    const { unmount } = render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Archived conversation 1')
    await userEvent.click(screen.getByTestId('archived-bulk-delete-button'))
    await userEvent.click(screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('archived-bulk-delete-confirm-dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(2)
    })
    expect(deleteArchivedConversationsBulk.mock.calls[0][0].items).toHaveLength(5)
    expect(deleteArchivedConversationsBulk.mock.calls[1][0].items).toHaveLength(1)
    expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
      '5 / 6'
    )
    expect(screen.getByTestId('archived-search-input')).not.toBeDisabled()

    unmount()
    render(<ArchivedConversationsSettingsPage />)
    expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
      '5 / 6'
    )

    resolveSecondBatch?.()

    await waitFor(() => {
      expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
        '6 / 6'
      )
    })
  })

  test('groups archived worktrees from the same project together', async () => {
    listArchivedConversations.mockResolvedValue({
      items: [
        {
          ...archivedItem,
          id: 'conversation-1',
          taskId: 'codex-1',
          projectKey: '/Users/crystal/.wegent-executor/workspace/worktrees/runtime-1/Wegent',
          projectName: 'Wegent',
          workspacePath: '/Users/crystal/.wegent-executor/workspace/worktrees/runtime-1/Wegent',
        },
        {
          ...archivedItem,
          id: 'conversation-2',
          taskId: 'codex-2',
          projectKey: '/Users/crystal/.wegent-executor/workspace/worktrees/runtime-2/Wegent',
          projectName: 'Wegent',
          workspacePath: '/Users/crystal/.wegent-executor/workspace/worktrees/runtime-2/Wegent',
        },
      ],
      projectGroups: [],
      total: 2,
    })

    render(<ArchivedConversationsSettingsPage />)

    await screen.findAllByText('Greet user')

    expect(screen.getByTestId('archived-project-filter')).toHaveTextContent('Wegent (2)')
    expect(screen.getByTestId('archived-group-Wegent')).toHaveTextContent('2')
  })
})
