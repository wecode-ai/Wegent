// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { deletePublishedApp, listPublishedApps } from '@wecode/api/published-apps'
import apiClient from '@/apis/client'

jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    delete: jest.fn(),
  },
}))

describe('published-apps API', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  test('listPublishedApps throws on non-zero code', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValue({
      code: 1,
      message: 'Published apps service request timed out',
    })

    await expect(listPublishedApps()).rejects.toThrow(/^Published apps service request timed out$/)
  })

  test('listPublishedApps returns data on success', async () => {
    const data = { total: 1, page: 1, page_size: 20, apps: [{ app_name: 'test' }] }
    ;(apiClient.get as jest.Mock).mockResolvedValue({ code: 0, message: 'ok', data })

    const result = await listPublishedApps()

    expect(apiClient.get).toHaveBeenCalledWith('/published-apps')
    expect(result).toEqual(data)
  })

  test('deletePublishedApp calls apiClient.delete with encoded app name', async () => {
    ;(apiClient.delete as jest.Mock).mockResolvedValue({ code: 0, message: 'success' })

    await deletePublishedApp('demo-app2')

    expect(apiClient.delete).toHaveBeenCalledWith('/published-apps/demo-app2')
  })

  test('deletePublishedApp throws on non-zero code', async () => {
    ;(apiClient.delete as jest.Mock).mockResolvedValue({
      code: 1,
      message: 'Failed to delete published app',
    })

    await expect(deletePublishedApp('test')).rejects.toThrow(/^Failed to delete published app$/)
  })
})
