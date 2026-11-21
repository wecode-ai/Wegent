// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { createCodeWiki } from '@/features/knowledge/code-wiki/createCodeWiki'
import { useKnowledgeBaseDialogs } from '@/features/knowledge/document/hooks/useKnowledgeBaseDialogs'
import { createKnowledgeBase, deleteKnowledgeBase } from '@/apis/knowledge'
import type { KnowledgeBase } from '@/types/knowledge'
import type { ContentDeletionOutcome } from '@/apis/knowledge-deletion'
import client from '@/apis/client'

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), warning: jest.fn() },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  migrateKnowledgeBaseToGroup: jest.fn(),
  createKnowledgeBase: jest.fn(),
  deleteKnowledgeBase: jest.fn(),
}))

jest.mock('@/features/knowledge/code-wiki/createCodeWiki', () => ({
  createCodeWiki: jest.fn(),
}))

describe('creating a Code Wiki', () => {
  it('does not dispatch an old deletion after the account changes during import', async () => {
    const scope = jest.spyOn(client, 'getCacheScope').mockReturnValue('account-a')
    try {
      const sidebar = {
        groups: [],
        selectedGroupId: null,
        currentUser: { id: 1 },
        selectedKbId: 1,
        saveKnowledgeBaseSettings: jest.fn(),
        refreshAll: jest.fn(),
        clearSelection: jest.fn(),
      }
      jest.mocked(deleteKnowledgeBase).mockResolvedValue({
        content_deleted: true,
        index_cleanup: 'confirmed',
        error_code: null,
        can_continue: false,
      })
      const { result } = renderHook(() => useKnowledgeBaseDialogs({ sidebar }))
      act(() => result.current.setDeletingKb({ id: 1 } as KnowledgeBase))
      let operation!: Promise<void>
      act(() => {
        operation = result.current.handleDelete(true)
        scope.mockReturnValue('account-b')
      })
      await act(async () => {
        await operation
      })
      expect(deleteKnowledgeBase).not.toHaveBeenCalled()
    } finally {
      scope.mockRestore()
    }
  })
  it.each([false, true])(
    'does not overwrite a new deletion target after pending deletion (account change: %s)',
    async accountChanged => {
      let resolve!: (outcome: ContentDeletionOutcome) => void
      const pending = new Promise<ContentDeletionOutcome>(done => {
        resolve = done
      })
      jest.mocked(deleteKnowledgeBase).mockReturnValue(pending)
      const push = jest.fn()
      jest.mocked(useRouter).mockReturnValue({ ...useRouter(), push })
      const sidebar = {
        groups: [],
        selectedGroupId: null,
        currentUser: { id: 1 },
        selectedKbId: 1,
        saveKnowledgeBaseSettings: jest.fn(),
        refreshAll: jest.fn().mockResolvedValue(undefined),
        clearSelection: jest.fn(),
      }
      const { result, rerender } = renderHook(
        ({ userId, selectedKbId }) =>
          useKnowledgeBaseDialogs({
            sidebar: {
              ...sidebar,
              currentUser: { id: userId },
              selectedKbId,
            },
          }),
        { initialProps: { userId: 1, selectedKbId: 1 } }
      )
      act(() => result.current.setDeletingKb({ id: 1 } as KnowledgeBase))
      let operation!: Promise<void>
      await act(async () => {
        operation = result.current.handleDelete(true)
        await Promise.resolve()
      })
      rerender({ userId: accountChanged ? 2 : 1, selectedKbId: 2 })
      act(() => result.current.setDeletingKb({ id: 2 } as KnowledgeBase))
      await act(async () => {
        resolve({
          content_deleted: true,
          index_cleanup: 'unconfirmed',
          error_code: 'external_engine_unavailable',
          can_continue: false,
        })
        await operation
      })
      expect(sidebar.clearSelection).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(result.current.deletingKb?.id).toBe(2)
      expect(result.current.isDeleting).toBe(false)
      expect(toast.warning).not.toHaveBeenCalled()
    }
  )
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
      saveKnowledgeBaseSettings: jest.fn(),
      refreshAll,
      clearSelection: jest.fn(),
    }
    const { result } = renderHook(() => useKnowledgeBaseDialogs({ sidebar }))

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
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.current.isCreating).toBe(false)

    resolveRefresh?.()
  })

  it('keeps the created wiki visible when only schedule configuration fails', async () => {
    jest.mocked(createCodeWiki).mockResolvedValue({
      id: 42,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-18T00:00:00Z',
      updated_at: '2026-08-18T00:00:00Z',
      scheduledUpdateError: 'Schedule service unavailable',
    })
    const sidebar = {
      groups: [],
      selectedGroupId: null,
      currentUser: { id: 1 },
      selectedKbId: null,
      saveKnowledgeBaseSettings: jest.fn(),
      refreshAll: jest.fn().mockResolvedValue(undefined),
      clearSelection: jest.fn(),
    }
    const { result } = renderHook(() => useKnowledgeBaseDialogs({ sidebar }))

    await act(async () => {
      await result.current.handleCreate({
        name: 'Wegent',
        kb_type: 'code_wiki',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
      })
    })

    expect(sidebar.refreshAll).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith('codeWiki.create.scheduleNotConfigured')
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.current.isCreating).toBe(false)
  })
})

describe('creating a normal knowledge base', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(createKnowledgeBase).mockResolvedValue({
      id: 7,
      name: 'Docs',
      description: null,
      user_id: 1,
      namespace: 'default',
      document_count: 0,
      is_active: true,
      summary_enabled: false,
      max_calls_per_conversation: 10,
      exempt_calls_before_check: 5,
      created_at: '2026-08-18T00:00:00Z',
      updated_at: '2026-08-18T00:00:00Z',
    })
  })

  it('forwards the dialog download setting instead of silently dropping it', async () => {
    const sidebar = {
      groups: [],
      selectedGroupId: null,
      currentUser: { id: 1 },
      selectedKbId: null,
      saveKnowledgeBaseSettings: jest.fn(),
      refreshAll: jest.fn().mockResolvedValue(undefined),
      clearSelection: jest.fn(),
    }
    const { result } = renderHook(() => useKnowledgeBaseDialogs({ sidebar }))

    await act(async () => {
      await result.current.handleCreate({
        name: 'Docs',
        allow_document_download: false,
      })
    })

    expect(createKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ allow_document_download: false })
    )
    expect(result.current.isCreating).toBe(false)
  })
})

it('rechecks the selected team before creating even through a previously captured submit callback', async () => {
  const sidebar = {
    groups: [{ id: 'group-team', name: 'team', displayName: 'Team', type: 'group' }],
    filterGroupId: 'group-team',
    selectedGroupId: null,
    currentUser: { id: 1 },
    selectedKbId: null,
    saveKnowledgeBaseSettings: jest.fn(),
    refreshAll: jest.fn().mockResolvedValue(undefined),
    clearSelection: jest.fn(),
  }
  const { result, rerender } = renderHook(
    ({ canCreate }) =>
      useKnowledgeBaseDialogs({
        sidebar,
        availableGroups: [
          { id: 'group-team', name: 'team', displayName: 'Team', type: 'group', canCreate },
        ],
      }),
    { initialProps: { canCreate: true } }
  )
  act(() => result.current.handleCreateKbFromAll('notebook'))
  expect(result.current.defaultCreateGroupId).toBe('group-team')
  const submit = result.current.handleCreate
  const calls = jest.mocked(createKnowledgeBase).mock.calls.length
  rerender({ canCreate: false })
  await act(async () => {
    await expect(submit({ name: 'Team library', selectedGroupId: 'group-team' })).rejects.toThrow(
      'document.creation.spaceUnavailable'
    )
  })
  expect(createKnowledgeBase).toHaveBeenCalledTimes(calls)
  expect(result.current.showCreateDialog).toBe(true)
})

it('ignores a late creation response after changing account and keeps the new scope idle', async () => {
  let finish!: (value: never) => void
  jest.mocked(createKnowledgeBase).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const base = {
    groups: [],
    selectedGroupId: null,
    selectedKbId: null,
    saveKnowledgeBaseSettings: jest.fn(),
    refreshAll: jest.fn().mockResolvedValue(undefined),
    clearSelection: jest.fn(),
  }
  const { result, rerender } = renderHook(
    ({ userId }) =>
      useKnowledgeBaseDialogs({
        sidebar: { ...base, currentUser: { id: userId } },
      }),
    { initialProps: { userId: 1 } }
  )
  let request!: Promise<void>
  act(() => {
    request = result.current.handleCreate({ name: 'Old library' })
  })
  await waitFor(() => expect(finish).toBeDefined())
  rerender({ userId: 2 })
  await act(async () => {
    finish({ id: 29, name: 'Old library', namespace: 'default' } as never)
    await request
  })
  expect(result.current.showCreateDialog).toBe(false)
  expect(result.current.isCreating).toBe(false)
  expect(base.refreshAll).not.toHaveBeenCalled()
})

it('does not send the deferred document create when its account scope has already changed', async () => {
  jest
    .mocked(createKnowledgeBase)
    .mockResolvedValue({ id: 29, name: 'Old library', namespace: 'default' } as never)
  const base = {
    groups: [],
    selectedGroupId: null,
    selectedKbId: null,
    saveKnowledgeBaseSettings: jest.fn(),
    refreshAll: jest.fn().mockResolvedValue(undefined),
    clearSelection: jest.fn(),
  }
  const { result, rerender } = renderHook(
    ({ userId }) =>
      useKnowledgeBaseDialogs({
        sidebar: { ...base, currentUser: { id: userId } },
      }),
    { initialProps: { userId: 1 } }
  )
  const calls = jest.mocked(createKnowledgeBase).mock.calls.length
  let request!: Promise<void>
  act(() => {
    request = result.current.handleCreate({ name: 'Old library' })
    rerender({ userId: 2 })
  })
  await act(async () => request)
  expect(createKnowledgeBase).toHaveBeenCalledTimes(calls)
  expect(result.current.showCreateDialog).toBe(false)
})

it.each([
  ['space:personal', 'personal'],
  ['organization', 'organization'],
])('opens creation in the selected space %s', (filter, expected) => {
  const sidebar = {
    groups: [],
    filterGroupId: filter,
    selectedGroupId: null,
    currentUser: { id: 1 },
    selectedKbId: null,
    saveKnowledgeBaseSettings: jest.fn(),
    refreshAll: jest.fn().mockResolvedValue(undefined),
    clearSelection: jest.fn(),
  }
  const { result } = renderHook(() => useKnowledgeBaseDialogs({ sidebar }))
  act(() => result.current.handleCreateKbFromAll('notebook'))
  expect(result.current.defaultCreateGroupId).toBe(expected)
  expect(result.current.showCreateDialog).toBe(true)
})
