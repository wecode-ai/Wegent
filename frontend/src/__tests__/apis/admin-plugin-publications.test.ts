// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminPluginPublicationApis } from '@/apis/admin-plugin-publications'
import { apiClient } from '@/apis/client'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
  },
}))

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('admin plugin publication APIs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('encodes queue filters and forwards the abort signal', async () => {
    const controller = new AbortController()
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0, page: 2, limit: 20 })

    await adminPluginPublicationApis.listPublicationRequests(
      {
        page: 2,
        limit: 20,
        status: 'awaiting_admin',
        riskLevel: 'high',
        submitter: ' alice ',
        query: ' mail plugin ',
        submittedAfter: '2026-08-01',
        submittedBefore: '2026-08-29',
      },
      controller.signal
    )

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/admin/plugins/publication-requests?page=2&limit=20&status=awaiting_admin&riskLevel=high&submitter=alice&query=mail+plugin&submittedAfter=2026-08-01T00%3A00%3A00.000Z&submittedBefore=2026-08-29T23%3A59%3A59.999Z',
      { signal: controller.signal }
    )
  })

  it('loads complete evidence for a selected historical revision', async () => {
    const controller = new AbortController()
    mockedApiClient.get.mockResolvedValue({})

    await adminPluginPublicationApis.getPublicationRequest(41, controller.signal, 2)

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/admin/plugins/publication-requests/41?revision=2',
      { signal: controller.signal }
    )
  })

  it('sends the current revision with every review action', async () => {
    mockedApiClient.post.mockResolvedValue({})

    await adminPluginPublicationApis.returnPublicationRequest(41, {
      currentRevision: 3,
      reason: 'The declaration is incomplete',
      requiredChanges: ['Declare the external domain'],
    })
    await adminPluginPublicationApis.acceptPublicationRequest(41, {
      currentRevision: 3,
      acknowledgedWarningCodes: ['risk.external_network'],
    })
    await adminPluginPublicationApis.reconcilePublicationRequest(
      41,
      {
        currentRevision: 3,
      },
      'reconcile-attempt-1'
    )

    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      1,
      '/admin/plugins/publication-requests/41/return',
      {
        currentRevision: 3,
        reason: 'The declaration is incomplete',
        requiredChanges: ['Declare the external domain'],
      },
      {
        headers: {
          'Idempotency-Key': expect.stringMatching(/^plugin-publication-admin-return-41-/),
        },
      }
    )
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      2,
      '/admin/plugins/publication-requests/41/accept',
      {
        currentRevision: 3,
        acknowledgedWarningCodes: ['risk.external_network'],
      },
      {
        headers: {
          'Idempotency-Key': expect.stringMatching(/^plugin-publication-admin-accept-41-/),
        },
      }
    )
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      3,
      '/admin/plugins/publication-requests/41/reconcile',
      { currentRevision: 3 },
      {
        headers: {
          'Idempotency-Key': expect.stringMatching(/^plugin-publication-admin-reconcile-41-/),
        },
      }
    )
  })

  it('reuses the same idempotency key for an identical review retry', async () => {
    mockedApiClient.post.mockResolvedValue({})
    const payload = {
      currentRevision: 3,
      acknowledgedWarningCodes: ['risk.external_network'],
    }

    await adminPluginPublicationApis.acceptPublicationRequest(41, payload)
    await adminPluginPublicationApis.acceptPublicationRequest(41, payload)

    const firstOptions = mockedApiClient.post.mock.calls[0]?.[2]
    const secondOptions = mockedApiClient.post.mock.calls[1]?.[2]
    expect(firstOptions).toEqual(secondOptions)
  })

  it('separates explicit reconcile attempts while preserving a transport retry key', async () => {
    mockedApiClient.post.mockResolvedValue({})
    const payload = { currentRevision: 3 }

    await adminPluginPublicationApis.reconcilePublicationRequest(41, payload, 'reconcile-attempt-a')
    await adminPluginPublicationApis.reconcilePublicationRequest(41, payload, 'reconcile-attempt-a')
    await adminPluginPublicationApis.reconcilePublicationRequest(41, payload, 'reconcile-attempt-b')

    const firstKey = new Headers(mockedApiClient.post.mock.calls[0]?.[2]?.headers).get(
      'Idempotency-Key'
    )
    const retryKey = new Headers(mockedApiClient.post.mock.calls[1]?.[2]?.headers).get(
      'Idempotency-Key'
    )
    const nextAttemptKey = new Headers(mockedApiClient.post.mock.calls[2]?.[2]?.headers).get(
      'Idempotency-Key'
    )
    expect(retryKey).toBe(firstKey)
    expect(nextAttemptKey).not.toBe(firstKey)
  })
})
