// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { createCodeWiki } from '@/features/knowledge/code-wiki/createCodeWiki'
import { useKnowledgeBaseDialogs } from '@/features/knowledge/document/hooks/useKnowledgeBaseDialogs'

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn() },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  migrateKnowledgeBaseToGroup: jest.fn(),
}))

jest.mock('@/features/knowledge/code-wiki/createCodeWiki', () => ({
  createCodeWiki: jest.fn(),
}))

describe('creating a Code Wiki', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(createCodeWiki).mockResolvedValue({
      id: 42,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-18T00:00:00Z',
      updated_at: '2026-08-18T00:00:00Z',
    })
  })

  it('stays in the list while refreshing the new wiki in the background', async () => {
    let resolveRefresh: (() => void) | undefined
    const refreshAll = jest.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefresh = resolve
        })
    )
    const sidebar = {
      groups: [],
      selectedGroupId: null,
      currentUser: { id: 1 },
      selectedKbId: null,
      refreshAll,
      clearSelection: jest.fn(),
    }
    const { result } = renderHook(() =>
      useKnowledgeBaseDialogs({ sidebar, reloadGroupKbs: jest.fn() })
    )

    await act(async () => {
      await result.current.handleCreate({
        name: 'Wegent',
        kb_type: 'code_wiki',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
      })
    })

    expect(refreshAll).toHaveBeenCalledTimes(1)
    expect(jest.mocked(useRouter).mock.results[0].value.push).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('codeWiki.create.created')
    expect(result.current.isCreating).toBe(false)

    resolveRefresh?.()
  })
})
