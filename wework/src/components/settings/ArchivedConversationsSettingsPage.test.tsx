import { createLocalAppServices } from '@/api/local/localServices'
import {
  readReplyPrediction,
  writeReplyPrediction,
} from '@/features/reply-predictions/replyPredictionCache'
import { notifyWorkbenchCloudArchivesChanged } from '@/features/workbench/workbenchCloudDataEvents'
import '@/i18n'
import {
  deleteArchivedLocalHarnessSession,
  listArchivedLocalHarnessSessions,
  notifyLocalHarnessSessionsChanged,
  unarchiveLocalHarnessSession,
} from '@/lib/local-terminal'
import type { ArchivedConversationItem } from '@/types/api'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import {
  reportArchivedCleanupFailure,
  resetArchivedConversationsSettingsStateForTest,
} from './archivedConversationsSettingsState'

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => ({
  deleteArchivedLocalHarnessSession: vi.fn(),
  listArchivedLocalHarnessSessions: vi.fn().mockResolvedValue([]),
  notifyLocalHarnessSessionsChanged: vi.fn(),
  unarchiveLocalHarnessSession: vi.fn(),
}))

const createLocalAppServicesMock = vi.mocked(createLocalAppServices)
const deleteArchivedLocalHarnessSessionMock = vi.mocked(deleteArchivedLocalHarnessSession)
const listArchivedLocalHarnessSessionsMock = vi.mocked(listArchivedLocalHarnessSessions)
const notifyLocalHarnessSessionsChangedMock = vi.mocked(notifyLocalHarnessSessionsChanged)
const unarchiveLocalHarnessSessionMock = vi.mocked(unarchiveLocalHarnessSession)

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

function archivedItemAt(
  index: number,
  overrides: Partial<ArchivedConversationItem> = {}
): ArchivedConversationItem {
  return {
    ...archivedItem,
    id: `conversation-${index}`,
    taskId: `codex-${index}`,
    title: `Archived conversation ${index}`,
    ...overrides,
  }
}

describe('ArchivedConversationsSettingsPage', () => {
  const listArchivedConversations = vi.fn()
  const deleteArchivedConversation = vi.fn()
  const deleteArchivedConversationsBulk = vi.fn()
  const unarchiveConversation = vi.fn()

  beforeEach(() => {
    createLocalAppServicesMock.mockReset()
    resetArchivedConversationsSettingsStateForTest()
    listArchivedConversations.mockReset().mockResolvedValue({
      items: [archivedItem],
      projectGroups: [],
      total: 1,
    })
    deleteArchivedConversation.mockReset().mockResolvedValue({})
    deleteArchivedConversationsBulk.mockReset().mockResolvedValue({ results: [] })
    unarchiveConversation.mockReset().mockResolvedValue({})
    deleteArchivedLocalHarnessSessionMock.mockReset().mockResolvedValue(undefined)
    listArchivedLocalHarnessSessionsMock.mockReset().mockResolvedValue([])
    notifyLocalHarnessSessionsChangedMock.mockReset()
    unarchiveLocalHarnessSessionMock.mockReset().mockResolvedValue(undefined)
    createLocalAppServicesMock.mockReturnValue({
      runtimeWorkApi: {
        listArchivedConversations,
        deleteArchivedConversation,
        deleteArchivedConversationsBulk,
        unarchiveConversation,
      },
    } as unknown as ReturnType<typeof createLocalAppServices>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('shows a current deletion error alongside an earlier task cleanup failure', async () => {
    reportArchivedCleanupFailure('another-task', 'Earlier cleanup failure')
    deleteArchivedConversationsBulk.mockRejectedValueOnce(new Error('Current deletion failed'))
    render(<ArchivedConversationsSettingsPage />)
    await userEvent.click(await screen.findByTestId('archived-bulk-delete-button'))
    await userEvent.click(screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button'))
    await waitFor(() => {
      expect(screen.getByTestId('archived-operation-error')).toHaveTextContent(
        'Earlier cleanup failure'
      )
      expect(screen.getByTestId('archived-operation-error')).toHaveTextContent(
        'Current deletion failed'
      )
    })
    await act(async () => notifyWorkbenchCloudArchivesChanged())
    expect(screen.getByTestId('archived-operation-error')).toHaveTextContent(
      'Current deletion failed'
    )
  })

  test.each(['local', 'cloud'] as const)(
    'clears only successfully deleted tasks in a partially failed %s bulk deletion',
    async source => {
      const items = [archivedItemAt(1, { source }), archivedItemAt(2, { source })]
      const scopes = items.map(item =>
        JSON.stringify([item.deviceId, item.taskId, item.workspacePath])
      )
      scopes.forEach(scope =>
        writeReplyPrediction(scope, {
          key: 'turn-1',
          text: '请继续',
          accepted: false,
          failed: false,
        })
      )
      listArchivedConversations
        .mockResolvedValueOnce({ items, projectGroups: [], total: 2 })
        .mockResolvedValue({ items: [], projectGroups: [], total: 0 })
      const results = [
        { taskId: items[0].taskId, deleted: true },
        { taskId: items[1].taskId, deleted: false },
      ]
      deleteArchivedConversationsBulk.mockResolvedValue({
        results: source === 'cloud' ? [{ results }] : results,
      })
      render(<ArchivedConversationsSettingsPage />)
      await screen.findByText('Archived conversation 1')
      await userEvent.click(screen.getByTestId('archived-bulk-delete-button'))
      await userEvent.click(
        screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button')
      )
      await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(readReplyPrediction(scopes[0], 'turn-1')).toBeNull())
      expect(readReplyPrediction(scopes[1], 'turn-1')?.text).toBe('请继续')
    }
  )

  test('isolates bulk deletion results for matching task IDs on different devices', async () => {
    const items = [
      archivedItemAt(1, { source: 'cloud' }),
      archivedItemAt(1, {
        id: 'other-device',
        title: 'Other device task',
        source: 'cloud',
        deviceId: 'device-2',
      }),
    ]
    const scopes = items.map(item =>
      JSON.stringify([item.deviceId, item.taskId, item.workspacePath])
    )
    scopes.forEach(scope =>
      writeReplyPrediction(scope, { key: 'turn-1', text: '请继续', accepted: false, failed: false })
    )
    listArchivedConversations
      .mockResolvedValueOnce({ items, projectGroups: [], total: 2 })
      .mockResolvedValue({ items: [], projectGroups: [], total: 0 })
    deleteArchivedConversationsBulk.mockImplementation(async ({ items: batch }) => ({
      results: [{ results: [{ taskId: 'codex-1', deleted: batch[0].deviceId === 'device-1' }] }],
    }))
    render(<ArchivedConversationsSettingsPage />)
    await screen.findByText('Other device task')
    await userEvent.click(screen.getByTestId('archived-bulk-delete-button'))
    await userEvent.click(screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button'))
    await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(2))
    expect(
      deleteArchivedConversationsBulk.mock.calls.map(([request]) => request.items.length)
    ).toEqual([1, 1])
    expect(readReplyPrediction(scopes[0], 'turn-1')).toBeNull()
    expect(readReplyPrediction(scopes[1], 'turn-1')?.text).toBe('请继续')
  })

  test('uses the compact Codex row and an in-app single delete confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Greet user')

    expect(screen.queryByText('/Users/crystal/dev/git/weekly-report')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archived-cleanup-preview-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archived-refresh-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('archived-filter-controls')).toHaveClass('sticky', 'top-0')
    expect(screen.getByTestId('archived-search-input')).toHaveClass('h-8', 'max-md:h-11')

    const deleteButton = screen.getByTestId('archived-delete-button-device-1-codex-1')
    const unarchiveButton = screen.getByTestId('archived-unarchive-button-device-1-codex-1')
    expect(deleteButton).toHaveClass('h-8', 'w-8', 'max-md:h-11', 'max-md:w-11')
    expect(unarchiveButton).toHaveClass('h-8', 'max-md:h-11')

    await userEvent.click(deleteButton)

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('archived-delete-confirm-dialog')).toHaveTextContent(
      '删除已归档任务?'
    )
    expect(screen.getByTestId('archived-delete-confirm-dialog')).toHaveTextContent(
      '这将永久删除已归档任务'
    )

    await userEvent.click(screen.getByTestId('archived-delete-confirm-dialog-confirm-button'))

    await waitFor(() => {
      expect(deleteArchivedConversation).toHaveBeenCalledWith({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-1',
      })
    })
    expect(screen.queryByText('Greet user')).not.toBeInTheDocument()
    expect(createLocalAppServices).toHaveBeenCalledTimes(1)
  })

  test('lists an archived OpenCode session and restores it to the workbench', async () => {
    listArchivedConversations.mockResolvedValue({
      items: [],
      projectGroups: [],
      total: 0,
    })
    listArchivedLocalHarnessSessionsMock
      .mockResolvedValueOnce([
        {
          session_id: 'local-harness-1',
          harness_id: 'opencode',
          title: 'Inspect archive flow',
          cwd: '/Users/test/Wegent',
          created_at: 1_786_506_000_000,
          archived_at: 1_786_506_100_000,
          is_primary: true,
          project_id: 7,
          active: false,
        },
      ])
      .mockResolvedValue([])
    const onLeaveSettings = vi.fn()

    render(<ArchivedConversationsSettingsPage onLeaveSettings={onLeaveSettings} />)

    expect(await screen.findByText('Inspect archive flow')).toBeInTheDocument()
    await userEvent.click(
      screen.getByTestId('archived-unarchive-button-local-harness-local-harness-1')
    )

    await waitFor(() =>
      expect(unarchiveLocalHarnessSessionMock).toHaveBeenCalledWith('local-harness-1')
    )
    expect(notifyLocalHarnessSessionsChangedMock).toHaveBeenCalledWith()
    await userEvent.click(await screen.findByTestId('archived-view-now-button'))

    expect(notifyLocalHarnessSessionsChangedMock).toHaveBeenLastCalledWith('local-harness-1')
    expect(onLeaveSettings).toHaveBeenCalled()
    expect(unarchiveConversation).not.toHaveBeenCalled()
  })

  test('deletes an archived OpenCode session without calling the runtime task API', async () => {
    listArchivedConversations.mockResolvedValue({
      items: [],
      projectGroups: [],
      total: 0,
    })
    listArchivedLocalHarnessSessionsMock.mockResolvedValue([
      {
        session_id: 'local-harness-2',
        harness_id: 'opencode',
        title: 'Delete archive flow',
        cwd: '/Users/test/Wegent',
        created_at: 1_786_506_000_000,
        archived_at: 1_786_506_100_000,
        is_primary: true,
        project_id: 7,
        active: false,
      },
    ])

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Delete archive flow')
    await userEvent.click(
      screen.getByTestId('archived-delete-button-local-harness-local-harness-2')
    )
    await userEvent.click(screen.getByTestId('archived-delete-confirm-dialog-confirm-button'))

    await waitFor(() =>
      expect(deleteArchivedLocalHarnessSessionMock).toHaveBeenCalledWith('local-harness-2')
    )
    expect(deleteArchivedConversation).not.toHaveBeenCalled()
  })

  test('deletes every task in a project in batches regardless of the active search', async () => {
    const projectItems = Array.from({ length: 6 }, (_, index) =>
      archivedItemAt(index + 1, {
        title: `Target ${index + 1}`,
        projectName: 'Target project',
        workspacePath: `/repos/target-${index + 1}`,
      })
    )
    const unrelatedItem = archivedItemAt(20, {
      title: 'Keep this task',
      projectName: 'Other project',
      workspacePath: '/repos/other',
    })
    listArchivedConversations
      .mockReset()
      .mockResolvedValueOnce({
        items: [...projectItems, unrelatedItem],
        projectGroups: [],
        total: 7,
      })
      .mockResolvedValue({
        items: [unrelatedItem],
        projectGroups: [],
        total: 1,
      })
    deleteArchivedConversationsBulk
      .mockReset()
      .mockResolvedValueOnce({
        results: projectItems.slice(0, 5).map(item => ({ taskId: item.taskId, deleted: true })),
      })
      .mockResolvedValueOnce({
        results: projectItems.slice(5).map(item => ({ taskId: item.taskId, deleted: true })),
      })

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Target 1')
    await userEvent.type(screen.getByTestId('archived-search-input'), 'Target 1')
    expect(screen.getByTestId('archived-group-count-Target-project')).toHaveTextContent('1 个任务')

    await userEvent.click(screen.getByTestId('archived-project-actions-Target-project'))
    await userEvent.click(screen.getByTestId('archived-delete-project-Target-project'))

    const dialog = screen.getByTestId('archived-project-delete-confirm-dialog')
    expect(dialog).toHaveTextContent('删除此项目中的全部任务?')
    expect(dialog).toHaveTextContent('“Target project”中的 6 个已归档任务')

    await userEvent.click(
      screen.getByTestId('archived-project-delete-confirm-dialog-confirm-button')
    )

    await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(2))
    expect(deleteArchivedConversationsBulk.mock.calls[0][0].items).toHaveLength(5)
    expect(deleteArchivedConversationsBulk.mock.calls[1][0].items).toHaveLength(1)
    expect(
      deleteArchivedConversationsBulk.mock.calls.flatMap(([request]) =>
        request.items.map((item: { taskId: string }) => item.taskId)
      )
    ).toEqual(projectItems.map(item => item.taskId))

    await userEvent.clear(screen.getByTestId('archived-search-input'))
    expect(await screen.findByText('Keep this task')).toBeInTheDocument()
    expect(screen.queryByText('Target 1')).not.toBeInTheDocument()
    expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
      '6 / 6'
    )
  })

  test('deletes all archived tasks regardless of source and search filters', async () => {
    let resolveCloudDelete: (() => void) | undefined
    const localItem = archivedItemAt(1, {
      title: 'Local target',
      projectName: 'Local project',
      source: 'local',
    })
    const cloudItem = archivedItemAt(2, {
      title: 'Cloud target',
      projectName: 'Cloud project',
      source: 'cloud',
      deviceId: 'cloud-device',
    })
    listArchivedConversations
      .mockReset()
      .mockResolvedValueOnce({ items: [localItem, cloudItem], projectGroups: [], total: 2 })
      .mockResolvedValue({ items: [], projectGroups: [], total: 0 })
    deleteArchivedConversationsBulk
      .mockReset()
      .mockResolvedValueOnce({
        results: [{ taskId: localItem.taskId, deleted: true }],
      })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveCloudDelete = () =>
              resolve({ results: [{ taskId: cloudItem.taskId, deleted: true }] })
          })
      )

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Local target')
    await userEvent.click(screen.getByTestId('archived-filter-menu'))
    await userEvent.click(screen.getByTestId('archived-source-option-local'))
    await userEvent.type(screen.getByTestId('archived-search-input'), 'Local')
    expect(screen.queryByText('Cloud target')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('archived-bulk-delete-button'))
    expect(screen.getByTestId('archived-bulk-delete-confirm-dialog')).toHaveTextContent(
      '删除全部已归档任务?'
    )
    await userEvent.click(screen.getByTestId('archived-bulk-delete-confirm-dialog-confirm-button'))

    await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(2))
    expect(deleteArchivedConversationsBulk.mock.calls[0][0].items).toEqual([
      {
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-1',
      },
    ])
    expect(deleteArchivedConversationsBulk.mock.calls[1][0].items).toEqual([
      {
        deviceId: 'cloud-device',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-2',
      },
    ])
    expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
      '1 / 2'
    )

    await act(async () => {
      resolveCloudDelete?.()
    })
    await waitFor(() =>
      expect(screen.getByTestId('archived-bulk-delete-background-progress')).toHaveTextContent(
        '2 / 2'
      )
    )
  })
})
