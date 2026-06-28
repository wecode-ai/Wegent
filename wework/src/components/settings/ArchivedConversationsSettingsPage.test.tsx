import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import { createHttpClient } from '@/api/http'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import '@/i18n'
import type { ArchivedConversationItem } from '@/types/api'

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ apiBaseUrl: '/api' }),
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/runtimeWork', () => ({
  createRuntimeWorkApi: vi.fn(),
}))

const createRuntimeWorkApiMock = vi.mocked(createRuntimeWorkApi)

const archivedItem: ArchivedConversationItem = {
  id: 'conversation-1',
  localTaskId: 'codex-1',
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

describe('ArchivedConversationsSettingsPage', () => {
  const listArchivedConversations = vi.fn()
  const deleteArchivedConversation = vi.fn()
  const deleteArchivedConversationsBulk = vi.fn()
  const unarchiveConversation = vi.fn()

  beforeEach(() => {
    listArchivedConversations.mockResolvedValue({
      items: [archivedItem],
      projectGroups: [],
      total: 1,
    })
    deleteArchivedConversation.mockResolvedValue({})
    deleteArchivedConversationsBulk.mockResolvedValue({})
    unarchiveConversation.mockResolvedValue({})
    createRuntimeWorkApiMock.mockReturnValue({
      listArchivedConversations,
      deleteArchivedConversation,
      deleteArchivedConversationsBulk,
      unarchiveConversation,
    } as unknown as ReturnType<typeof createRuntimeWorkApi>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('opens an in-app delete confirmation dialog instead of the browser confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<ArchivedConversationsSettingsPage />)

    await screen.findByText('Greet user')

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
        localTaskId: 'codex-1',
      })
    })
    expect(listArchivedConversations).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Greet user')).not.toBeInTheDocument()
    expect(createHttpClient).toHaveBeenCalledWith({ baseUrl: '/api' })
  })
})
