// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { codeWikiApi } from '@/apis/code-wiki'
import { createCodeWiki } from '@/features/knowledge/code-wiki/createCodeWiki'

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { create: jest.fn() },
}))

describe('createCodeWiki', () => {
  it('forwards the complete form through the dedicated API without UI-only fields', async () => {
    jest.mocked(codeWikiApi.create).mockResolvedValue({
      id: 17,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-11T00:00:00Z',
      updated_at: '2026-08-11T00:00:00Z',
    })

    await createCodeWiki({
      namespace: 'team-a',
      data: {
        name: '',
        description: undefined,
        kb_type: 'code_wiki',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        language: 'zh',
        resolved_name: 'Wegent',
        resolved_description: 'Agent platform',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
        selectedGroupId: 'group-team-a',
      },
    })

    expect(codeWikiApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Wegent',
        description: 'Agent platform',
        namespace: 'team-a',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
      })
    )
    expect(codeWikiApi.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ kb_type: expect.anything() })
    )
    expect(codeWikiApi.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ selectedGroupId: expect.anything() })
    )
  })
})
