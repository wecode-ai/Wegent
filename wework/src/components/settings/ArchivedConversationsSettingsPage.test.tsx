import { render, screen, waitFor, within } from '@testing-library/react'
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

  test('uses the injected hybrid API and offers View now after unarchiving', async () => {
    const onRefreshWorkLists = vi.fn().mockResolvedValue(undefined)
    const onOpenRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const onLeaveSettings = vi.fn()
    const api = {
      listArchivedConversations,
      deleteArchivedConversation,
      deleteArchivedConversationsBulk,
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

  test('combines source and sort choices in a checked popup menu', async () => {
    listArchivedConversations.mockResolvedValue({
      items: [
        archivedItemAt(1, {
          title: 'Zebra task',
          projectName: 'Wegent',
          source: 'local',
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt: '2026-07-03T10:00:00Z',
        }),
        archivedItemAt(2, {
          title: 'Alpha task',
          projectName: 'Wegent',
          source: 'cloud',
          deviceId: 'cloud-device',
          deviceAddress: 'cloud.example.com',
          createdAt: '2026-07-04T10:00:00Z',
          updatedAt: '2026-07-02T10:00:00Z',
        }),
      ],
      projectGroups: [],
      total: 2,
    })

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Zebra task')
    const filterMenuButton = screen.getByTestId('archived-filter-menu')
    expect(filterMenuButton).toHaveClass('h-8', 'max-md:h-11')
    expect(filterMenuButton).toHaveTextContent('所有任务')

    await userEvent.click(filterMenuButton)

    expect(screen.getByTestId('archived-source-option-all')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('archived-sort-option-updated')).toHaveAttribute(
      'aria-checked',
      'true'
    )

    await userEvent.click(screen.getByTestId('archived-source-option-cloud'))

    expect(filterMenuButton).toHaveTextContent('云端')
    expect(screen.queryByText('Zebra task')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    expect(screen.getByText('cloud.example.com')).toBeInTheDocument()

    await userEvent.click(filterMenuButton)
    await userEvent.click(screen.getByTestId('archived-source-option-all'))
    await userEvent.click(filterMenuButton)
    await userEvent.click(screen.getByTestId('archived-sort-option-alphabetical'))

    const rows = within(screen.getByTestId('archived-group-Wegent')).getAllByTestId(
      /^archived-item-/
    )
    expect(rows[0]).toHaveTextContent('Alpha task')
    expect(rows[1]).toHaveTextContent('Zebra task')

    await userEvent.click(filterMenuButton)
    expect(screen.getByTestId('archived-sort-option-alphabetical')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  test('groups projects with icons and counts, then hides the header for one selected project', async () => {
    listArchivedConversations.mockResolvedValue({
      items: [
        archivedItemAt(1, {
          title: 'Wegent task one',
          projectName: 'Wegent',
          workspacePath: '/worktrees/runtime-1/Wegent',
        }),
        archivedItemAt(2, {
          title: 'Wegent task two',
          projectName: 'Wegent',
          workspacePath: '/worktrees/runtime-2/Wegent',
        }),
        archivedItemAt(3, {
          title: 'Other task',
          projectName: 'Other',
          workspacePath: '/repos/Other',
        }),
      ],
      projectGroups: [],
      total: 3,
    })

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Wegent task one')

    expect(screen.getByTestId('archived-group-count-Wegent')).toHaveTextContent('2 个任务')
    expect(screen.getByRole('heading', { name: 'Wegent' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('archived-project-actions-Wegent')).toHaveAttribute(
      'aria-haspopup',
      'menu'
    )

    await userEvent.click(screen.getByTestId('archived-project-actions-Wegent'))
    expect(screen.getByTestId('archived-delete-project-Wegent')).toHaveTextContent(
      '删除此项目中的全部任务'
    )

    await userEvent.click(screen.getByTestId('archived-project-filter'))
    expect(screen.getByTestId('archived-project-option-all')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await userEvent.click(screen.getByTestId('archived-project-option-Wegent'))

    expect(screen.getByTestId('archived-project-filter')).toHaveTextContent('Wegent')
    expect(screen.queryByRole('heading', { name: 'Wegent' })).not.toBeInTheDocument()
    expect(screen.queryByText('Other task')).not.toBeInTheDocument()
    expect(screen.getByText('Wegent task one')).toBeInTheDocument()
    expect(screen.getByText('Wegent task two')).toBeInTheDocument()
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
    deleteArchivedConversationsBulk.mockReset().mockResolvedValueOnce({
      results: [localItem, cloudItem].map(item => ({ taskId: item.taskId, deleted: true })),
    })

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

    await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(1))
    expect(deleteArchivedConversationsBulk.mock.calls[0][0].items).toEqual([
      {
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-1',
      },
      {
        deviceId: 'cloud-device',
        workspacePath: '/Users/crystal/dev/git/weekly-report',
        taskId: 'codex-2',
      },
    ])
  })

  test('keeps background batch progress visible across remounts', async () => {
    const archivedItems = Array.from({ length: 6 }, (_, index) => archivedItemAt(index + 1))
    let resolveSecondBatch: (() => void) | undefined
    listArchivedConversations
      .mockReset()
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
      .mockReset()
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

    await waitFor(() => expect(deleteArchivedConversationsBulk).toHaveBeenCalledTimes(2))
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

  test('renders empty and load failure states', async () => {
    listArchivedConversations.mockReset().mockResolvedValue({
      items: [],
      projectGroups: [],
      total: 0,
    })

    const { unmount } = render(<ArchivedConversationsSettingsPage />)

    expect(await screen.findByTestId('archived-empty')).toHaveTextContent('暂无已归档任务。')
    expect(screen.queryByTestId('archived-filter-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('archived-bulk-delete-button')).not.toBeInTheDocument()

    unmount()
    listArchivedConversations.mockReset().mockRejectedValueOnce(new Error('executor offline'))
    render(<ArchivedConversationsSettingsPage />)

    expect(await screen.findByTestId('archived-error')).toHaveTextContent('executor offline')
  })
})
