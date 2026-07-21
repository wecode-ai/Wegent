// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AgentDefaultKnowledgeScopeSelector } from '@/features/settings/components/knowledge/AgentDefaultKnowledgeScopeSelector'
import type { ContextItem } from '@/types/context'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; name?: string }) =>
      ({
        'team.simple.core.default_knowledge_scope.all': 'Whole library',
        'team.simple.core.default_knowledge_scope.description':
          'Configure the knowledge sources this agent uses by default for new chats. Existing chats are not affected.',
        'team.simple.core.default_knowledge_scope.label': 'Default knowledge scope',
        'team.simple.core.default_knowledge_scope.load_failed': 'Knowledge sources failed to load',
        'team.simple.core.default_knowledge_scope.partial': `${options?.count ?? 0} documents selected`,
        'team.simple.core.default_knowledge_scope.remove': `Remove ${options?.name ?? ''}`,
        'team.simple.core.default_knowledge_scope.search':
          'Search knowledge bases, documents, or external sources',
        'team.simple.core.default_knowledge_scope.select': 'Select knowledge',
        'team.simple.core.default_knowledge_scope.visibility_hint':
          "Source names will be visible to this agent's users.",
      })[key] || key,
  }),
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: jest.fn().mockResolvedValue({
      personal: { created_by_me: [], shared_with_me: [] },
      groups: [],
      organization: { knowledge_bases: [] },
      summary: {
        total_count: 0,
        personal_count: 0,
        group_count: 0,
        organization_count: 0,
      },
    }),
  },
}))

jest.mock('@/features/knowledge/document/extension-loader', () => ({
  loadKBExtensions: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => [],
}))

jest.mock('@/features/tasks/components/chat/KnowledgeSourcePicker', () => ({
  KnowledgeSourcePicker: ({
    onSelect,
    onReplaceContexts,
  }: {
    onSelect: (context: ContextItem) => void
    onReplaceContexts?: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
  }) => (
    <div data-testid="mock-knowledge-source-picker">
      <button
        type="button"
        onClick={() =>
          onReplaceContexts?.(
            [],
            [
              {
                id: 42,
                name: 'Product Manual',
                type: 'knowledge_base',
                document_ids: [101],
                document_names: ['Install Guide'],
                scope_restricted: true,
              },
            ]
          )
        }
      >
        Select internal document
      </button>
      <button
        type="button"
        onClick={() =>
          onSelect({
            id: 'external:dingtalk:explicit:docs:document:doc-1',
            name: 'Spec A',
            type: 'external_knowledge',
            ref: {
              provider: 'dingtalk',
              mode: 'explicit',
              id: 'docs',
              name: 'DingTalk Docs',
              target_type: 'document',
              node_id: 'doc-1',
              document_id: 'doc-1',
              target_name: 'Spec A',
            },
          })
        }
      >
        Select external document
      </button>
    </div>
  ),
}))

describe('AgentDefaultKnowledgeScopeSelector', () => {
  it('aggregates selected defaults and splits save outputs by storage field', async () => {
    const onKnowledgeChange = jest.fn()
    const onExternalChange = jest.fn()

    render(
      <AgentDefaultKnowledgeScopeSelector
        defaultKnowledgeBaseRefs={[]}
        onDefaultKnowledgeBaseRefsChange={onKnowledgeChange}
        defaultExternalKnowledgeRefs={[
          {
            provider: 'ap',
            mode: 'explicit',
            id: 'risk',
            name: 'AP Risk Rules',
            target_type: 'document',
            node_id: 'rule-1',
            document_id: 'rule-1',
            target_name: 'Rule 1',
          },
          {
            provider: 'ap',
            mode: 'explicit',
            id: 'risk',
            name: 'AP Risk Rules',
            target_type: 'document',
            node_id: 'rule-2',
            document_id: 'rule-2',
            target_name: 'Rule 2',
          },
        ]}
        onDefaultExternalKnowledgeRefsChange={onExternalChange}
      />
    )

    expect(screen.getByText('AP Risk Rules · 2 documents selected')).toBeInTheDocument()
    expect(screen.getAllByTestId(/agent-default-knowledge-scope-chip-/)).toHaveLength(1)

    fireEvent.click(screen.getByTestId('agent-default-knowledge-scope-trigger'))
    fireEvent.click(await screen.findByRole('button', { name: 'Select internal document' }))

    expect(onKnowledgeChange).toHaveBeenCalledWith([
      {
        id: 42,
        name: 'Product Manual',
        document_ids: [101],
        document_names: ['Install Guide'],
        include_subfolders: true,
        scope_restricted: true,
      },
    ])
    expect(onExternalChange).toHaveBeenCalledWith([
      {
        provider: 'ap',
        mode: 'explicit',
        id: 'risk',
        name: 'AP Risk Rules',
        target_type: 'document',
        node_id: 'rule-1',
        document_id: 'rule-1',
        target_name: 'Rule 1',
      },
      {
        provider: 'ap',
        mode: 'explicit',
        id: 'risk',
        name: 'AP Risk Rules',
        target_type: 'document',
        node_id: 'rule-2',
        document_id: 'rule-2',
        target_name: 'Rule 2',
      },
    ])

    fireEvent.click(
      screen.getByTestId('agent-default-knowledge-scope-remove-external-ap-explicit-risk')
    )

    await waitFor(() => {
      expect(onExternalChange).toHaveBeenLastCalledWith([])
    })
  })
})
