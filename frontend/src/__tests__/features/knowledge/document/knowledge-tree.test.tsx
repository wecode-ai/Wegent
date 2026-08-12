// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { KnowledgeTree } from '@/features/knowledge/document/components/KnowledgeTree'
import type { TreeNode } from '@/features/knowledge/document/hooks/useKnowledgeTree'
import type { Group } from '@/types/group'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}))

function createGroup(): Group {
  return {
    id: 1,
    name: 'engineering',
    display_name: 'Engineering',
    parent_name: null,
    owner_user_id: 1,
    visibility: 'internal',
    level: 'group',
    description: null,
    is_active: true,
    my_role: 'Reporter',
    created_at: '2026-04-03T00:00:00Z',
    updated_at: '2026-04-03T00:00:00Z',
  }
}

function createKnowledgeBase(): KnowledgeBase {
  return {
    id: 8,
    name: 'Shared KB',
    description: null,
    user_id: 99,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: false,
    kb_type: 'notebook',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-04-03T00:00:00Z',
    updated_at: '2026-04-03T00:00:00Z',
  }
}

function renderTree(overrides?: {
  canManageGroup?: (group: Group) => boolean
  canManageKb?: (kb: KnowledgeBase) => boolean
}) {
  const group = createGroup()
  const kb = createKnowledgeBase()

  const nodes: TreeNode[] = [
    {
      id: `group-${group.name}`,
      type: 'group-item',
      label: group.display_name || group.name,
      group,
      expanded: true,
      children: [
        {
          id: `kb-${kb.id}`,
          type: 'kb-leaf',
          label: kb.name,
          knowledgeBase: kb,
          scope: 'group',
          groupName: group.name,
        },
      ],
    },
  ]

  render(
    <KnowledgeTree
      nodes={nodes}
      selectedKbId={null}
      loading={false}
      expandState={{ [`group-${group.name}`]: true }}
      onToggleExpand={jest.fn()}
      onSelectKb={jest.fn()}
      onCreateKb={jest.fn()}
      onOpenGroupSettings={jest.fn()}
      onEditKb={jest.fn()}
      canManageGroup={overrides?.canManageGroup}
      canManageKb={overrides?.canManageKb}
    />
  )
}

describe('KnowledgeTree permissions', () => {
  it('hides settings actions when manage callbacks are missing', () => {
    renderTree()

    expect(screen.queryByTestId('group-settings-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kb-settings-8')).not.toBeInTheDocument()
  })

  it('hides settings actions when manage callbacks return false', () => {
    renderTree({
      canManageGroup: () => false,
      canManageKb: () => false,
    })

    expect(screen.queryByTestId('group-settings-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kb-settings-8')).not.toBeInTheDocument()
  })

  it('shows settings actions when manage callbacks return true', () => {
    renderTree({
      canManageGroup: () => true,
      canManageKb: () => true,
    })

    expect(screen.getByTestId('group-settings-1')).toBeInTheDocument()
    expect(screen.getByTestId('kb-settings-8')).toBeInTheDocument()
  })
})

describe('KnowledgeTree category filter', () => {
  it('uses the generic empty state for the default all category', () => {
    render(
      <KnowledgeTree
        nodes={[]}
        selectedKbId={null}
        loading={false}
        expandState={{}}
        onToggleExpand={jest.fn()}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
      />
    )

    expect(screen.getByText('暂无知识库')).toBeInTheDocument()
  })

  it('filters the mobile tree by document or code category', async () => {
    const user = userEvent.setup()
    const documentKb = createKnowledgeBase()
    const codeWiki = {
      ...createKnowledgeBase(),
      id: 9,
      name: 'Code Wiki',
      kb_type: 'code_wiki' as const,
    }
    const nodes: TreeNode[] = [
      {
        id: 'personal',
        type: 'category-root',
        label: 'My Knowledge',
        expanded: true,
        children: [
          {
            id: `kb-${documentKb.id}`,
            type: 'kb-leaf',
            label: documentKb.name,
            knowledgeBase: documentKb,
            kbType: documentKb.kb_type,
          },
          {
            id: `kb-${codeWiki.id}`,
            type: 'kb-leaf',
            label: codeWiki.name,
            knowledgeBase: codeWiki,
            kbType: codeWiki.kb_type,
          },
        ],
      },
    ]

    render(
      <KnowledgeTree
        nodes={nodes}
        selectedKbId={null}
        loading={false}
        expandState={{ personal: true }}
        onToggleExpand={jest.fn()}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
      />
    )

    await user.click(screen.getByTestId('knowledge-category-code-filter'))
    expect(screen.queryByTestId(`knowledge-tree-kb-${documentKb.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`knowledge-tree-kb-${codeWiki.id}`)).toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-category-document-filter'))
    expect(screen.getByTestId(`knowledge-tree-kb-${documentKb.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`knowledge-tree-kb-${codeWiki.id}`)).not.toBeInTheDocument()
  })

  it('returns to all when the selected code category disappears', async () => {
    const user = userEvent.setup()
    const documentKb = createKnowledgeBase()
    const codeWiki = { ...createKnowledgeBase(), id: 9, kb_type: 'code_wiki' as const }
    const { rerender } = render(
      <KnowledgeTree
        nodes={[
          {
            id: 'personal',
            type: 'category-root',
            label: 'My Knowledge',
            expanded: true,
            children: [
              {
                id: `kb-${documentKb.id}`,
                type: 'kb-leaf',
                label: documentKb.name,
                knowledgeBase: documentKb,
              },
              {
                id: `kb-${codeWiki.id}`,
                type: 'kb-leaf',
                label: codeWiki.name,
                knowledgeBase: codeWiki,
              },
            ],
          },
        ]}
        selectedKbId={null}
        loading={false}
        expandState={{ personal: true }}
        onToggleExpand={jest.fn()}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
      />
    )

    await user.click(screen.getByTestId('knowledge-category-code-filter'))
    rerender(
      <KnowledgeTree
        nodes={[
          {
            id: 'personal',
            type: 'category-root',
            label: 'My Knowledge',
            expanded: true,
            children: [
              {
                id: `kb-${documentKb.id}`,
                type: 'kb-leaf',
                label: documentKb.name,
                knowledgeBase: documentKb,
              },
            ],
          },
        ]}
        selectedKbId={null}
        loading={false}
        expandState={{ personal: true }}
        onToggleExpand={jest.fn()}
        onSelectKb={jest.fn()}
        onCreateKb={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId(`knowledge-tree-kb-${documentKb.id}`)).toBeInTheDocument()
    )
    expect(screen.queryByTestId('knowledge-category-code-filter')).not.toBeInTheDocument()
  })
})
