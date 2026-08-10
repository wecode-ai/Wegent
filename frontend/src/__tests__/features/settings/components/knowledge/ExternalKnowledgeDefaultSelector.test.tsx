// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ExternalKnowledgeDefaultSelector } from '@/features/settings/components/knowledge/ExternalKnowledgeDefaultSelector'
import type { ExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'

const mockListKnowledgeBases = jest.fn()
const mockListNodes = jest.fn()
const mockGetScopeStatuses = jest.fn()
const mockSyncScope = jest.fn()
let mockExternalSources: ExternalKnowledgeSource[] = []

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'team.simple.core.external_knowledge_select': 'Select external knowledge...',
        'team.simple.core.external_knowledge_loading': 'Loading external knowledge...',
        'team.simple.core.external_knowledge_load_failed': 'External knowledge failed to load',
        'team.simple.core.external_knowledge_empty': 'No external knowledge is available',
        'team.simple.core.external_knowledge_dingtalk_docs': 'DingTalk Docs',
        'team.simple.core.external_knowledge_dingtalk_docs_not_configured':
          'DingTalk Docs MCP is not configured',
        'team.simple.core.external_knowledge_dingtalk_docs_empty':
          'DingTalk Docs is configured but has no synced content',
        'team.simple.core.external_knowledge_dingtalk_wikispace_not_configured':
          'DingTalk Knowledge Base MCP is not configured',
        'team.simple.core.external_knowledge_dingtalk_wikispace_empty':
          'DingTalk Knowledge Base is configured but has no synced content',
        'team.simple.core.external_knowledge_go_to_settings': 'Settings',
        'team.simple.core.external_knowledge_sync_now': 'Sync now',
        'team.simple.core.external_knowledge_syncing': 'Syncing...',
        'team.simple.core.external_knowledge_helper':
          'Used to initialize new chats with external knowledge sources.',
      })[key] || key,
  }),
}))

jest.mock('@/features/knowledge/document/extension-loader', () => ({
  loadKBExtensions: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => mockExternalSources,
}))

function openSelector() {
  render(<ExternalKnowledgeDefaultSelector value={[]} onChange={jest.fn()} />)
  fireEvent.click(screen.getByTestId('default-external-knowledge-trigger'))
}

describe('ExternalKnowledgeDefaultSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListKnowledgeBases.mockResolvedValue({ items: [], has_more: false })
    mockListNodes.mockResolvedValue({ items: [], has_more: false })
    mockGetScopeStatuses.mockResolvedValue([
      {
        key: 'personal',
        configured: false,
        synced: false,
        messageKey: 'team.simple.core.external_knowledge_dingtalk_docs_not_configured',
        testId: 'default-external-knowledge-docs',
      },
      {
        key: 'organization',
        configured: false,
        synced: false,
        messageKey: 'team.simple.core.external_knowledge_dingtalk_wikispace_not_configured',
        testId: 'default-external-knowledge-wikispace',
      },
    ])
    mockSyncScope.mockResolvedValue(undefined)
    mockExternalSources = [
      {
        providerId: 'dingtalk',
        label: 'DingTalk',
        capabilities: {
          enforcesPerUserAccess: true,
          supportsAgentDefault: true,
          supportsKnowledgeBaseSelection: true,
          supportsDocumentSelection: true,
        },
        scopes: [
          {
            key: 'personal',
            configureHref: '/settings?section=integrations&tab=integrations',
            syncHref: '/settings?section=integrations&tab=integrations',
          },
          {
            key: 'organization',
            configureHref: '/settings?section=integrations&tab=integrations',
            syncHref: '/settings?section=integrations&tab=integrations',
          },
        ],
        listKnowledgeBases: mockListKnowledgeBases,
        listNodes: mockListNodes,
        getScopeStatuses: mockGetScopeStatuses,
        syncScope: mockSyncScope,
      },
    ]
  })

  it('shows separate settings links when DingTalk docs and wikispace are not configured', async () => {
    openSelector()

    expect(await screen.findByText('DingTalk Docs MCP is not configured')).toBeInTheDocument()
    expect(screen.getByText('DingTalk Knowledge Base MCP is not configured')).toBeInTheDocument()
    expect(screen.getByTestId('default-external-knowledge-docs-settings-link')).toHaveAttribute(
      'href',
      '/settings?section=integrations&tab=integrations'
    )
    expect(
      screen.getByTestId('default-external-knowledge-wikispace-settings-link')
    ).toHaveAttribute('href', '/settings?section=integrations&tab=integrations')
  })

  it('shows sync actions when sources are configured but not synced', async () => {
    mockGetScopeStatuses.mockResolvedValue([
      {
        key: 'personal',
        configured: true,
        synced: false,
        messageKey: 'team.simple.core.external_knowledge_dingtalk_docs_empty',
        testId: 'default-external-knowledge-docs',
      },
      {
        key: 'organization',
        configured: true,
        synced: false,
        messageKey: 'team.simple.core.external_knowledge_dingtalk_wikispace_empty',
        testId: 'default-external-knowledge-wikispace',
      },
    ])

    openSelector()

    fireEvent.click(await screen.findByTestId('default-external-knowledge-docs-sync-button'))
    fireEvent.click(screen.getByTestId('default-external-knowledge-wikispace-sync-button'))

    await waitFor(() => {
      expect(mockSyncScope).toHaveBeenCalledWith('personal')
      expect(mockSyncScope).toHaveBeenCalledWith('organization')
    })
  })

  it('keeps available options visible while showing missing source actions', async () => {
    const knowledgeBaseName = 'DingTalk 项目知识库 2026 年度跨部门集成联调资料全集'
    const documentName = '2026 年度权限验收说明最终版.docx'
    mockListKnowledgeBases.mockResolvedValue({
      items: [
        {
          provider: 'dingtalk',
          knowledge_base_id: 'docs',
          knowledge_base_name: knowledgeBaseName,
          scope: 'personal',
          document_count: 1,
        },
      ],
      has_more: false,
    })
    mockListNodes.mockResolvedValue({
      items: [
        {
          node_id: 'folder-1',
          name: 'Folder',
          node_type: 'folder',
          children: [
            {
              node_id: 'doc-1',
              raw_id: 'doc-1',
              name: documentName,
              node_type: 'document',
            },
          ],
        },
      ],
      has_more: false,
    })
    mockGetScopeStatuses.mockResolvedValue([
      {
        key: 'organization',
        configured: false,
        synced: false,
        messageKey: 'team.simple.core.external_knowledge_dingtalk_wikispace_not_configured',
        testId: 'default-external-knowledge-wikispace',
      },
    ])

    openSelector()

    const option = await screen.findByTestId(
      'default-external-knowledge-option-dingtalk:explicit:docs:document:doc-1:personal'
    )
    expect(option).not.toHaveAttribute('title')
    expect(option).toHaveAttribute('aria-label', `${knowledgeBaseName} / Folder / ${documentName}`)
    expect(screen.getByText(`${knowledgeBaseName} / ${documentName}`)).toHaveClass('truncate')
    expect(screen.getByText('DingTalk Knowledge Base MCP is not configured')).toBeInTheDocument()
  })

  it('keeps selected long default refs bounded with full-name metadata', () => {
    const knowledgeBaseName = 'AP 企业知识库 2026 年度跨部门集成联调与权限验收说明资料全集'
    const targetName = '项目资料 / 需求说明 / 2026 年度权限验收说明最终版.docx'

    render(
      <ExternalKnowledgeDefaultSelector
        value={[
          {
            provider: 'ap',
            mode: 'explicit',
            id: 'lib-1',
            name: knowledgeBaseName,
            target_type: 'document',
            node_id: 'doc-1',
            target_name: targetName,
          },
        ]}
        onChange={jest.fn()}
      />
    )

    const chip = screen.getByTestId(
      'default-external-knowledge-chip-ap:explicit:lib-1:document:doc-1:'
    )
    expect(chip).not.toHaveAttribute('title')
    expect(chip).toHaveAttribute('aria-label', `${knowledgeBaseName} / ${targetName}`)
    expect(screen.getByText(targetName)).toHaveClass('truncate')
    expect(
      screen.getByTestId('default-external-knowledge-remove-ap:explicit:lib-1:document:doc-1:')
    ).toHaveClass('shrink-0')
  })
})
