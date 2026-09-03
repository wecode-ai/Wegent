// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminPluginPublicationApis } from '@/apis/admin-plugin-publications'
import PluginPublicationReviewQueue from '@/features/admin/components/PluginPublicationReviewQueue'

const mockRouterReplace = jest.fn()
let mockSearchParams = new URLSearchParams('tab=wework-plugin-publications')
const mockToast = jest.fn()
const mockT = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/apis/admin-plugin-publications', () => ({
  adminPluginPublicationApis: {
    listPublicationRequests: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/features/admin/components/PluginPublicationReviewDrawer', () => ({
  __esModule: true,
  default: ({ requestId }: { requestId: number | null }) =>
    requestId === null ? null : <div data-testid="mock-plugin-publication-drawer">{requestId}</div>,
}))

const mockedPublicationApis = adminPluginPublicationApis as jest.Mocked<
  typeof adminPluginPublicationApis
>

describe('PluginPublicationReviewQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('tab=wework-plugin-publications')
    mockedPublicationApis.listPublicationRequests.mockResolvedValue({
      items: [
        {
          id: 41,
          pluginId: 7,
          pluginName: 'Company Mail',
          pluginSlug: 'sina-email',
          requestedVersion: '1.2.0',
          submitter: { id: 9, userName: 'alice' },
          currentRevision: 3,
          stage: 'administrator_review',
          status: 'awaiting_admin',
          riskLevel: 'medium',
          blockerCount: 0,
          warningCount: 1,
          submittedAt: '2026-08-29T01:00:00Z',
          updatedAt: '2026-08-29T02:00:00Z',
          gitlabStatus: 'MR · Pipeline pending',
          waitingDurationSeconds: 7200,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    })
  })

  it('loads the review queue and opens a deep-linked request drawer', async () => {
    render(<PluginPublicationReviewQueue />)

    expect(await screen.findByText('Company Mail')).toBeInTheDocument()
    expect(mockedPublicationApis.listPublicationRequests).toHaveBeenCalledWith(
      {
        page: 1,
        limit: 20,
        status: 'awaiting_admin',
        riskLevel: 'all',
        submitter: '',
        query: '',
        submittedAfter: '',
        submittedBefore: '',
      },
      expect.any(AbortSignal)
    )

    expect(screen.getByTestId('plugin-publication-review-row-41')).toHaveTextContent(
      'v1.2.0 · Revision 3'
    )
    expect(screen.getByTestId('plugin-publication-review-row-41')).toHaveTextContent(
      'MR · Pipeline pending'
    )
    expect(screen.getByTestId('plugin-publication-review-row-41')).toHaveTextContent(
      '2026-08-29 09:00:00'
    )
    expect(screen.getByTestId('plugin-publication-review-row-41')).toHaveTextContent(
      'marketplace_management.plugin_publications.queue.waiting_hours'
    )
    fireEvent.click(screen.getByTestId('plugin-publication-review-row-41'))

    expect(screen.getByTestId('mock-plugin-publication-drawer')).toHaveTextContent('41')
    await waitFor(() =>
      expect(mockRouterReplace).toHaveBeenCalledWith('?tab=wework-plugin-publications&request=41', {
        scroll: false,
      })
    )
  })

  it('restores all queue filters from the URL and syncs time changes back to it', async () => {
    mockSearchParams = new URLSearchParams(
      'tab=wework-plugin-publications&status=ci_running&risk=high&submitter=alice&query=mail&submittedAfter=2026-08-01&submittedBefore=2026-08-29&page=2'
    )

    render(<PluginPublicationReviewQueue />)

    await waitFor(() =>
      expect(mockedPublicationApis.listPublicationRequests).toHaveBeenCalledWith(
        {
          page: 2,
          limit: 20,
          status: 'ci_running',
          riskLevel: 'high',
          submitter: 'alice',
          query: 'mail',
          submittedAfter: '2026-08-01',
          submittedBefore: '2026-08-29',
        },
        expect.any(AbortSignal)
      )
    )
    expect(screen.getByTestId('plugin-publication-review-filter-search')).toHaveValue('mail')
    expect(screen.getByTestId('plugin-publication-review-filter-submitter')).toHaveValue('alice')

    fireEvent.change(screen.getByTestId('plugin-publication-review-filter-submitted-after'), {
      target: { value: '2026-08-05' },
    })

    expect(mockRouterReplace).toHaveBeenCalledWith(
      '?tab=wework-plugin-publications&status=ci_running&risk=high&submitter=alice&query=mail&submittedAfter=2026-08-05&submittedBefore=2026-08-29',
      { scroll: false }
    )
    await waitFor(() =>
      expect(mockedPublicationApis.listPublicationRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({ submittedAfter: '2026-08-05' }),
        expect.any(AbortSignal)
      )
    )
  })

  it('opens a row with the keyboard', async () => {
    render(<PluginPublicationReviewQueue />)

    const row = await screen.findByTestId('plugin-publication-review-row-41')
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.getByTestId('mock-plugin-publication-drawer')).toHaveTextContent('41')
  })
})
