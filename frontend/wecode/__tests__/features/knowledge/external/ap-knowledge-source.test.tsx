// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import type { ExternalKnowledgeBase } from '@wecode/types/external-knowledge'

jest.mock('@wecode/api/external-knowledge', () => ({
  getExternalKnowledgePreview: jest.fn(),
  listExternalKnowledgeBases: jest.fn(),
  listExternalKnowledgeNodes: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const ORG_KB: ExternalKnowledgeBase = {
  provider: 'ap',
  knowledge_base_id: 'kb-org-1',
  knowledge_base_name: 'Org Handbook',
  scope: 'organization',
}

async function loadApSource() {
  jest.resetModules()

  const registry = await import('@/features/knowledge/externalKnowledgeSourceRegistry')
  const api = (await import('@wecode/api/external-knowledge')) as unknown as {
    listExternalKnowledgeBases: jest.Mock
  }

  // Import for side-effect: registers the AP source into the registry.
  await import('@wecode/features/knowledge/external/ap-knowledge-source')

  return {
    getExternalKnowledgeSource: registry.getExternalKnowledgeSource,
    mockList: api.listExternalKnowledgeBases,
  }
}

async function loadApSourceViaWecodeBootstrap() {
  jest.resetModules()

  const registry = await import('@/features/knowledge/externalKnowledgeSourceRegistry')
  const wecodeI18n = await import('@wecode/i18n')

  await wecodeI18n.loadWecodeResources()

  return {
    getExternalKnowledgeSource: registry.getExternalKnowledgeSource,
  }
}

describe('AP knowledge source registration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('registers an "ap" source into the provider-neutral registry', async () => {
    const { getExternalKnowledgeSource } = await loadApSource()
    expect(getExternalKnowledgeSource('ap')).toBeDefined()
  })

  it('registers AP through the wecode frontend bootstrap', async () => {
    const { getExternalKnowledgeSource } = await loadApSourceViaWecodeBootstrap()
    expect(getExternalKnowledgeSource('ap')).toBeDefined()
  })

  it('passes listKnowledgeBases params through the provider-neutral registry', async () => {
    const { getExternalKnowledgeSource, mockList } = await loadApSource()
    mockList.mockResolvedValue({ items: [ORG_KB] })
    const source = getExternalKnowledgeSource('ap')
    await source!.listKnowledgeBases?.({ scope: 'all', limit: 100, offset: 0 })
    expect(mockList).toHaveBeenCalledWith('ap', { scope: 'all', limit: 100, offset: 0 })
  })

  it('loads the WeiboAP knowledge base count with a one-item list request', async () => {
    const { getExternalKnowledgeSource, mockList } = await loadApSource()
    mockList.mockResolvedValueOnce({ items: [ORG_KB], total: 7 })
    const source = getExternalKnowledgeSource('ap')
    await expect(source!.getKnowledgeBaseCount?.()).resolves.toBe(7)
    expect(mockList).toHaveBeenCalledWith('ap', { scope: 'all', limit: 1, offset: 0 })
  })

  it('builds a full ExternalKnowledgeRef with mode and scope preserved', async () => {
    const { getExternalKnowledgeSource } = await loadApSource()
    const source = getExternalKnowledgeSource('ap')
    expect(source!.toRef?.(ORG_KB)).toEqual({
      provider: 'ap',
      mode: 'explicit',
      id: 'kb-org-1',
      name: 'Org Handbook',
      scope: 'organization',
    })
  })

  it('declares the AP explicit knowledge base selection limit', async () => {
    const { getExternalKnowledgeSource } = await loadApSource()
    const source = getExternalKnowledgeSource('ap')
    expect(source!.selectionLimits?.maxKnowledgeBases).toBe(100)
  })

  it('exposes whole-knowledge-base selection without document browsing', async () => {
    const { getExternalKnowledgeSource } = await loadApSource()
    const source = getExternalKnowledgeSource('ap')

    expect(source!.capabilities).toEqual({
      supportsKnowledgeBaseSelection: true,
      supportsDocumentSelection: false,
      supportsDocumentTree: false,
      supportsScopedRetrieval: false,
      supportsPreview: false,
    })
    expect(source!.listNodes).toBeUndefined()
    expect(source!.getPreview).toBeUndefined()
  })

  it('declares AP scopes through the provider registry', async () => {
    const { getExternalKnowledgeSource } = await loadApSource()
    const source = getExternalKnowledgeSource('ap')
    expect(source!.scopes).toEqual([
      {
        key: 'personal',
        labelKey: 'picker.scopes.personal',
        icon: 'personal',
      },
      {
        key: 'organization',
        labelKey: 'picker.scopes.organization',
        icon: 'organization',
      },
    ])
  })
})
