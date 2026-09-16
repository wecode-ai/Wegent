// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, renderHook } from '@testing-library/react'

import { useKnowledgeBaseDialogs } from '@/features/knowledge/document/hooks/useKnowledgeBaseDialogs'
import type { KnowledgeBaseCreate } from '@/types/knowledge'

const mockCreateKnowledgeBase = jest.fn()
const mockCreateCodeWiki = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock('@/apis/knowledge', () => ({
  migrateKnowledgeBaseToGroup: jest.fn(),
  createKnowledgeBase: (...args: unknown[]) => mockCreateKnowledgeBase(...args),
}))

jest.mock('@/features/knowledge/code-wiki/createCodeWiki', () => ({
  createCodeWiki: (...args: unknown[]) => mockCreateCodeWiki(...args),
}))

function buildSidebar() {
  return {
    groups: [
      { id: 'personal', name: 'default', displayName: 'Personal', type: 'personal' },
      { id: 'team', name: 'team-a', displayName: 'Team A', type: 'group' },
      { id: 'org', name: 'acme', displayName: 'Acme', type: 'organization' },
    ],
    selectedGroupId: null,
    currentUser: { id: 1 },
    selectedKbId: null,
    refreshAll: jest.fn().mockResolvedValue(undefined),
    clearSelection: jest.fn(),
  }
}

function renderDialogsHook() {
  return renderHook(() =>
    useKnowledgeBaseDialogs({
      sidebar: buildSidebar(),
      reloadGroupKbs: jest.fn(),
    })
  )
}

function createPayload(
  overrides?: Partial<Omit<KnowledgeBaseCreate, 'namespace'>> & { selectedGroupId?: string }
): Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string } {
  return {
    name: 'KB',
    description: undefined,
    direct_access_requirement: 'read',
    kb_type: 'notebook',
    ...overrides,
  }
}

describe('useKnowledgeBaseDialogs download setting', () => {
  beforeEach(() => {
    mockCreateKnowledgeBase.mockReset().mockResolvedValue({})
    mockCreateCodeWiki.mockReset().mockResolvedValue({})
  })

  it('leaves the download setting unset for the backend in the organization scope', async () => {
    const { result } = renderDialogsHook()
    act(() => result.current.setCreateScope('organization'))

    await act(async () => {
      await result.current.handleCreate(createPayload())
    })

    const payload = mockCreateKnowledgeBase.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ namespace: 'acme' }))
    expect(payload.allow_document_download).toBeUndefined()
  })

  it('leaves the download setting unset for the backend in a personal scope', async () => {
    const { result } = renderDialogsHook()

    await act(async () => {
      await result.current.handleCreate(createPayload())
    })

    const payload = mockCreateKnowledgeBase.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ namespace: 'default' }))
    expect(payload.allow_document_download).toBeUndefined()
  })

  it('keeps an explicit download choice over the scope default', async () => {
    const { result } = renderDialogsHook()
    act(() => result.current.setCreateScope('organization'))

    await act(async () => {
      await result.current.handleCreate(createPayload({ allow_document_download: true }))
    })

    expect(mockCreateKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ allow_document_download: true })
    )
  })

  it('leaves the setting unset when the group selector targets the organization', async () => {
    const { result } = renderDialogsHook()
    act(() => result.current.setShowGroupSelector(true))

    await act(async () => {
      await result.current.handleCreate(createPayload({ selectedGroupId: 'org' }))
    })

    const payload = mockCreateKnowledgeBase.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ namespace: 'acme' }))
    expect(payload.allow_document_download).toBeUndefined()
  })

  it('leaves the setting unset through the code wiki creation path', async () => {
    const { result } = renderDialogsHook()
    act(() => result.current.setCreateScope('organization'))

    await act(async () => {
      await result.current.handleCreate(createPayload({ kb_type: 'code_wiki' }))
    })

    expect(mockCreateKnowledgeBase).not.toHaveBeenCalled()
    const payload = mockCreateCodeWiki.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ namespace: 'acme' }))
    expect(payload.data.allow_document_download).toBeUndefined()
  })

  it('does not let stale scope state override the selected namespace default', async () => {
    const { result } = renderDialogsHook()
    act(() => result.current.setCreateScope('organization'))

    await act(async () => {
      await result.current.handleCreate(createPayload({ selectedGroupId: 'team' }))
    })

    const payload = mockCreateKnowledgeBase.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ namespace: 'team-a' }))
    expect(payload.allow_document_download).toBeUndefined()
  })
})
