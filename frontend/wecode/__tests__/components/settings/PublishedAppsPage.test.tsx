// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import PublishedAppsPage from '@wecode/components/settings/PublishedAppsPage'
import { deletePublishedApp, listPublishedApps } from '@wecode/api/published-apps'

jest.mock('@wecode/api/published-apps', () => ({
  deletePublishedApp: jest.fn(),
  listPublishedApps: jest.fn(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'yinlu', email: 'yinlu@example.com' },
    isLoading: false,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'published_apps.title': 'Published Apps',
        'published_apps.description': 'Applications published by yinlu',
        'published_apps.refresh': 'Refresh',
        'published_apps.columns.name': 'Name',
        'published_apps.columns.task_id': 'Task ID',
        'published_apps.columns.domain': 'Domain',
        'published_apps.columns.status': 'Status',
        'published_apps.columns.created_at': 'Created At',
        'published_apps.columns.conversation': 'Conversation',
        'published_apps.columns.action': 'Action',
        'published_apps.actions.chat': 'Chat',
        'published_apps.actions.delete': 'Delete',
        'published_apps.actions.deleting': 'Deleting...',
        'published_apps.confirm_delete': `Delete ${options?.appName}?`,
        'published_apps.status.running': 'Running',
        'published_apps.status.online': 'Online',
        'published_apps.errors.timeout': 'The published apps service timed out',
        'published_apps.summary': `${options?.count ?? 0} apps`,
      }
      return translations[key] || key
    },
    i18n: { language: 'en' },
  }),
}))

describe('PublishedAppsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(listPublishedApps as jest.Mock).mockResolvedValue({
      total: 1,
      page: 1,
      page_size: 20,
      apps: [
        {
          app_name: 'comedy-monitor',
          task_id: 123,
          username: 'yinlu',
          namespace: 'wb-plat-ide-quickstart',
          env: 'prod',
          pod_name: 'wecode-ide-quickstart-1611116-cbfc9f694-wffz5',
          pod_ip: '10.36.6.67',
          host_ip: '10.34.5.94',
          node_name: '10.34.5.94',
          status: 'running',
          ready: true,
          restarts: 0,
          app_url: 'http://comedy-monitor.yinlu.wegent.intra.weibo.com',
          admin_port: '8444',
          is_online: true,
          created_at: 1776951721,
          expires_at: 0,
          last_check_at: 1777277254,
        },
      ],
    })
    ;(deletePublishedApp as jest.Mock).mockResolvedValue({ code: 0, message: 'success' })
  })

  test('renders published apps for the current user', async () => {
    render(<PublishedAppsPage />)

    await waitFor(() => expect(listPublishedApps).toHaveBeenCalledWith())

    expect(screen.getByText('comedy-monitor')).toBeInTheDocument()
    expect(screen.getByText('123')).toBeInTheDocument()
    expect(screen.getByText('comedy-monitor.yinlu.wegent.intra.weibo.com')).toBeInTheDocument()
    expect(screen.getByText('Running / Online')).toBeInTheDocument()
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/code?taskId=123')
  })

  test('deletes a published app after confirmation and reloads the list', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PublishedAppsPage />)

    await screen.findByText('comedy-monitor')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deletePublishedApp).toHaveBeenCalledWith('comedy-monitor'))
    expect(listPublishedApps).toHaveBeenCalledTimes(2)
  })

  test('shows a localized timeout error', async () => {
    ;(listPublishedApps as jest.Mock).mockRejectedValue(
      new Error('Published apps service request timed out')
    )

    render(<PublishedAppsPage />)

    expect(await screen.findByText('The published apps service timed out')).toBeInTheDocument()
  })
})
