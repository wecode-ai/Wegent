// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { createTextKnowledgeDocument } from '@/apis/knowledge'

jest.mock('@/apis/client', () => ({
  apiClient: {
    post: jest.fn(),
  },
}))

describe('createTextKnowledgeDocument', () => {
  it('fixes the document source, format, and root folder', async () => {
    const document = { id: 42 }
    ;(apiClient.post as jest.Mock).mockResolvedValue(document)

    await expect(
      createTextKnowledgeDocument({
        knowledge_base_id: 7,
        name: 'Saved answer',
        content: '# Saved answer',
      })
    ).resolves.toBe(document)

    expect(apiClient.post).toHaveBeenCalledWith('/knowledge/documents', {
      knowledge_base_id: 7,
      name: 'Saved answer',
      content: '# Saved answer',
      source_type: 'text',
      file_extension: 'md',
      folder_id: 0,
    })
  })
})
