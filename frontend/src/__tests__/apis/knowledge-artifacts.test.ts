// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { knowledgeArtifactApi } from '@/apis/knowledge-artifacts'
import client from '@/apis/client'

jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}))

describe('knowledgeArtifactApi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses knowledge-base scoped CRUD routes', async () => {
    ;(client.get as jest.Mock).mockResolvedValue({
      items: [],
      can_manage: true,
      available_document_count: 1,
      processing_document_count: 0,
    })
    ;(client.post as jest.Mock).mockResolvedValue({ artifact_id: 'artifact-1' })
    ;(client.patch as jest.Mock).mockResolvedValue({ artifact_id: 'artifact-1' })
    ;(client.delete as jest.Mock).mockResolvedValue(undefined)

    await knowledgeArtifactApi.list(12)
    await knowledgeArtifactApi.create(12, {
      artifact_type: 'briefing',
      document_ids: [101],
    })
    await knowledgeArtifactApi.rename(12, 'artifact-1', '新标题')
    await knowledgeArtifactApi.retry(12, 'artifact-1')
    await knowledgeArtifactApi.delete(12, 'artifact-1')

    expect(client.get).toHaveBeenCalledWith('/knowledge-bases/12/artifacts')
    expect(client.post).toHaveBeenNthCalledWith(1, '/knowledge-bases/12/artifacts', {
      artifact_type: 'briefing',
      document_ids: [101],
    })
    expect(client.patch).toHaveBeenCalledWith('/knowledge-bases/12/artifacts/artifact-1', {
      title: '新标题',
    })
    expect(client.post).toHaveBeenNthCalledWith(2, '/knowledge-bases/12/artifacts/artifact-1/retry')
    expect(client.delete).toHaveBeenCalledWith('/knowledge-bases/12/artifacts/artifact-1')
  })
})
