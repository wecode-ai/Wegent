// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getExternalDocumentImportStatuses } from '@/apis/knowledge'
import { apiClient } from '@/apis/client'

jest.mock('@/apis/client', () => ({ apiClient: { post: jest.fn() } }))

describe('external document import status lookup', () => {
  beforeEach(() => jest.resetAllMocks())

  it('checks all candidates beyond the first page in bounded, deduplicated requests', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `doc-${index}`)
    jest
      .mocked(apiClient.post)
      .mockResolvedValueOnce({ 'doc-0': 'success' })
      .mockResolvedValueOnce({ 'doc-500': 'failed' })

    const result = await getExternalDocumentImportStatuses(42, 'dingtalk', [...ids, 'doc-0'])

    expect(result).toEqual({ 'doc-0': 'success', 'doc-500': 'failed' })
    expect(apiClient.post).toHaveBeenCalledTimes(2)
    expect(apiClient.post).toHaveBeenNthCalledWith(
      1,
      '/knowledge-bases/42/documents/external-import-status',
      { provider: 'dingtalk', external_resource_ids: ids.slice(0, 500) }
    )
    expect(apiClient.post).toHaveBeenNthCalledWith(
      2,
      '/knowledge-bases/42/documents/external-import-status',
      { provider: 'dingtalk', external_resource_ids: ['doc-500'] }
    )
  })

  it('does not represent a failed batch as a partial successful lookup', async () => {
    jest
      .mocked(apiClient.post)
      .mockResolvedValueOnce({ 'doc-0': 'success' })
      .mockRejectedValueOnce(new Error('offline'))
    await expect(
      getExternalDocumentImportStatuses(
        42,
        'dingtalk',
        Array.from({ length: 501 }, (_, index) => `doc-${index}`)
      )
    ).rejects.toThrow('offline')
  })
})
