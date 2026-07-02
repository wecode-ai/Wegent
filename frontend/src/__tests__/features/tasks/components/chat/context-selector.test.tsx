// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'
import type { ContextItem } from '@/types/context'

const mockListKnowledgeBases = jest.fn()
const mockGetAllGroupedKnowledgeBases = jest.fn()
const mockGetOrganizationNamespace = jest.fn()
const mockGetFolderTree = jest.fn()
const mockListDocuments = jest.fn()
const mockGetBoundKnowledgeBases = jest.fn()
const mockGetDingTalkDocs = jest.fn()
const mockGetDingTalkSyncStatus = jest.fn()
const mockGetDingTalkWikispaceNodes = jest.fn()
const mockGetDingTalkWikispaceSyncStatus = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/link', () => {
  const MockLink = ({ children }: { children: React.ReactNode }) => <a>{children}</a>
  MockLink.displayName = 'MockLink'
  return MockLink
})

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    list: (...args: unknown[]) => mockListKnowledgeBases(...args),
    getAllGrouped: (...args: unknown[]) => mockGetAllGroupedKnowledgeBases(...args),
  },
}))

jest.mock('@/apis/knowledge', () => ({
  getOrganizationNamespace: (...args: unknown[]) => mockGetOrganizationNamespace(...args),
  getFolderTree: (...args: unknown[]) => mockGetFolderTree(...args),
  listDocuments: (...args: unknown[]) => mockListDocuments(...args),
}))

jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: {
    getBoundKnowledgeBases: (...args: unknown[]) => mockGetBoundKnowledgeBases(...args),
  },
}))

jest.mock('@/apis/table', () => ({
  tableApi: {
    list: jest.fn().mockResolvedValue({ items: [] }),
  },
}))

jest.mock('@/apis/dingtalk-doc', () => ({
  dingtalkDocApi: {
    getDocs: (...args: unknown[]) => mockGetDingTalkDocs(...args),
    getSyncStatus: (...args: unknown[]) => mockGetDingTalkSyncStatus(...args),
    getWikispaceNodes: (...args: unknown[]) => mockGetDingTalkWikispaceNodes(...args),
    getWikispaceSyncStatus: (...args: unknown[]) => mockGetDingTalkWikispaceSyncStatus(...args),
    syncDocs: jest.fn().mockResolvedValue({ added: 0, updated: 0, deleted: 0, total: 0 }),
    syncWikispaceNodes: jest.fn().mockResolvedValue({ added: 0, updated: 0, deleted: 0, total: 0 }),
  },
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children, side }: { children: React.ReactNode; side?: string }) => (
    <div data-testid="context-selector-popover" data-side={side}>
      {children}
    </div>
  ),
}))

jest.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode
    heading?: React.ReactNode
  }) => (
    <section>
      {heading}
      {children}
    </section>
  ),
  CommandInput: () => null,
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}))

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function createGroupedKnowledgeBase(data: {
  id: number
  name: string
  namespace: string
  description?: string | null
  document_count?: number
}) {
  return {
    id: data.id,
    name: data.name,
    namespace: data.namespace,
    description: data.description ?? null,
    document_count: data.document_count ?? 0,
    kb_type: 'notebook',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    user_id: 1,
    group_id: data.namespace,
    group_name: data.namespace,
    group_type: data.namespace === 'default' ? 'personal' : 'group',
  }
}

function createAllGroupedResponse({
  personal = [],
  groups = [],
  organization = [],
}: {
  personal?: ReturnType<typeof createGroupedKnowledgeBase>[]
  groups?: Array<{
    group_name: string
    group_display_name: string
    knowledge_bases: ReturnType<typeof createGroupedKnowledgeBase>[]
  }>
  organization?: ReturnType<typeof createGroupedKnowledgeBase>[]
}) {
  return {
    personal: {
      created_by_me: personal,
      shared_with_me: [],
    },
    groups: groups.map(group => ({
      ...group,
      kb_count: group.knowledge_bases.length,
    })),
    organization: {
      namespace: 'acme-corp',
      display_name: 'Acme Corp',
      kb_count: organization.length,
      knowledge_bases: organization,
    },
    summary: {
      total_count:
        personal.length +
        organization.length +
        groups.reduce((total, group) => total + group.knowledge_bases.length, 0),
      personal_count: personal.length,
      group_count: groups.reduce((total, group) => total + group.knowledge_bases.length, 0),
      organization_count: organization.length,
    },
  }
}

describe('ContextSelector organization grouping', () => {
  beforeEach(() => {
    mockListKnowledgeBases.mockResolvedValue({ items: [] })
    mockGetBoundKnowledgeBases.mockResolvedValue({ items: [] })
    mockGetAllGroupedKnowledgeBases.mockResolvedValue(
      createAllGroupedResponse({
        organization: [
          createGroupedKnowledgeBase({
            id: 1,
            name: 'Org KB',
            namespace: 'acme-corp',
            description: 'Company docs',
            document_count: 3,
          }),
        ],
      })
    )
    mockGetOrganizationNamespace.mockResolvedValue({
      namespace: 'acme-corp',
    })
    mockGetFolderTree.mockResolvedValue([])
    mockListDocuments.mockResolvedValue({ items: [] })
    mockGetDingTalkDocs.mockResolvedValue({ nodes: [], total_count: 0 })
    mockGetDingTalkSyncStatus.mockResolvedValue({
      is_configured: true,
      last_synced_at: null,
      total_nodes: 0,
    })
    mockGetDingTalkWikispaceNodes.mockResolvedValue({ nodes: [], total_count: 0 })
    mockGetDingTalkWikispaceSyncStatus.mockResolvedValue({
      is_configured: true,
      last_synced_at: null,
      total_nodes: 0,
    })
  })

  it('shows knowledge bases under the organization section when the organization namespace is dynamic', async () => {
    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    expect(screen.getByText('picker.sources.organization')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByText('Org KB')).toBeInTheDocument()
    })
  })

  it('opens above the input toolbar to match adjacent toolbar popovers', async () => {
    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    expect(screen.getByTestId('context-selector-popover')).toHaveAttribute('data-side', 'top')
  })

  it('selects an internal knowledge base on row click and uses the backend document limit', async () => {
    const onSelect = jest.fn()

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={onSelect}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        name: 'Org KB',
        type: 'knowledge_base',
      })
    )
    await waitFor(() => {
      expect(mockListDocuments).toHaveBeenCalledWith(1, { limit: 200, offset: 0 })
    })
  })

  it('expands group knowledge into first-level group rows before showing knowledge bases', async () => {
    mockGetAllGroupedKnowledgeBases.mockResolvedValue(
      createAllGroupedResponse({
        groups: [
          {
            group_name: 'dev-group',
            group_display_name: 'Dev Experience',
            knowledge_bases: [
              createGroupedKnowledgeBase({
                id: 2,
                name: 'Group KB',
                namespace: 'dev-group',
                description: 'Team docs',
                document_count: 4,
              }),
            ],
          },
        ],
      })
    )

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-group')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-group'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-group-dev-group')).toBeInTheDocument()
    })
    expect(screen.getByText('Dev Experience')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-picker-kb-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-group-dev-group'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-2')).toBeInTheDocument()
    })
  })

  it('keeps empty groups visible in the group knowledge section', async () => {
    mockGetAllGroupedKnowledgeBases.mockResolvedValue(
      createAllGroupedResponse({
        groups: [
          {
            group_name: 'empty-group',
            group_display_name: 'Empty Group',
            knowledge_bases: [],
          },
          {
            group_name: 'dev-group',
            group_display_name: 'Dev Experience',
            knowledge_bases: [
              createGroupedKnowledgeBase({
                id: 2,
                name: 'Group KB',
                namespace: 'dev-group',
              }),
            ],
          },
        ],
      })
    )

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-group')).toBeInTheDocument()
    })

    expect(screen.getByTestId('knowledge-picker-source-group')).toHaveTextContent('2')
    fireEvent.click(screen.getByTestId('knowledge-picker-source-group'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-group-empty-group')).toBeInTheDocument()
    })

    expect(screen.getByText('Empty Group')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-picker-group-empty-group')).toHaveTextContent('0')

    fireEvent.click(screen.getByTestId('knowledge-picker-group-empty-group'))
    await waitFor(() => {
      expect(screen.getByText('picker.emptyKnowledgeBases')).toBeInTheDocument()
    })
  })

  it('shows group-chat bound knowledge bases even though they are filtered from normal lists', async () => {
    const onSelect = jest.fn()
    mockGetBoundKnowledgeBases.mockResolvedValue({
      items: [
        {
          id: 77,
          name: 'Bound KB',
          namespace: 'team-space',
          display_name: 'Bound KB',
          description: 'Task bound docs',
          document_count: 6,
          bound_by: 'owner',
          bound_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    mockGetAllGroupedKnowledgeBases.mockResolvedValue(
      createAllGroupedResponse({
        personal: [
          createGroupedKnowledgeBase({
            id: 77,
            name: 'Bound KB',
            namespace: 'team-space',
            document_count: 6,
          }),
        ],
      })
    )

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={onSelect}
        onDeselect={jest.fn()}
        taskId={42}
        isGroupChat={true}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByText('picker.boundKnowledgeBases')).toBeInTheDocument()
    })
    expect(screen.getByTestId('knowledge-picker-kb-77')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-kb-77'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 77,
        name: 'Bound KB',
        type: 'knowledge_base',
      })
    )
  })

  it('falls back to namespace when a group display name is missing', async () => {
    mockGetAllGroupedKnowledgeBases.mockResolvedValue(
      createAllGroupedResponse({
        groups: [
          {
            group_name: 'fallback-group',
            group_display_name: '',
            knowledge_bases: [
              createGroupedKnowledgeBase({
                id: 3,
                name: 'Fallback Group KB',
                namespace: 'fallback-group',
              }),
            ],
          },
        ],
      })
    )

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-group')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-group'))
    await waitFor(() => {
      expect(screen.getByText('fallback-group')).toBeInTheDocument()
    })
  })

  it('toggles internal knowledge documents by clicking the document row', async () => {
    const contextChanges = jest.fn()
    mockGetFolderTree.mockResolvedValue([
      {
        id: 10,
        name: 'Specs',
        children: [],
      },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        {
          id: 101,
          name: 'API.md',
          folder_id: 10,
        },
      ],
    })

    function StatefulSelector() {
      const [contexts, setContexts] = useState<ContextItem[]>([])
      const updateContexts = (next: ContextItem[]) => {
        contextChanges(next)
        setContexts(next)
      }

      return (
        <ContextSelector
          open={true}
          onOpenChange={jest.fn()}
          selectedContexts={contexts}
          onSelect={context => updateContexts([...contexts, context])}
          onDeselect={id => updateContexts(contexts.filter(context => context.id !== id))}
          onReplaceContexts={(idsToRemove, contextsToAdd) => {
            const idSet = new Set(idsToRemove)
            updateContexts([
              ...contexts.filter(context => !idSet.has(context.id)),
              ...contextsToAdd,
            ])
          }}
        >
          <button>trigger</button>
        </ContextSelector>
      )
    }

    render(<StatefulSelector />)

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-101')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Specs').length).toBeGreaterThan(1)
    fireEvent.click(screen.getByTestId('knowledge-picker-document-node-document-101'))

    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 1,
          type: 'knowledge_base',
          scope_restricted: true,
          document_ids: [101],
        }),
      ])
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-document-node-document-101'))
    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([])
    })
  })

  it('filters internal documents by folder path and shows flat search results', async () => {
    mockGetFolderTree.mockResolvedValue([
      {
        id: 10,
        name: 'Specs',
        children: [],
      },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        {
          id: 101,
          name: 'API.md',
          folder_id: 10,
        },
      ],
    })

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-101')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByTestId('context-selector-knowledge-search-input'), {
      target: { value: 'Specs' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-101')).toBeInTheDocument()
    })
    expect(screen.getByText('API.md')).toBeInTheDocument()
    expect(screen.getByText('Specs')).toBeInTheDocument()
  })

  it('pages through all internal documents before scoped document search and selection', async () => {
    const firstPageDocuments = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `Document ${index + 1}.md`,
      folder_id: 0,
    }))
    const onSelect = jest.fn()

    mockListDocuments.mockClear()
    mockListDocuments
      .mockResolvedValueOnce({
        items: firstPageDocuments,
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 201,
            name: 'Beyond First Page.md',
            folder_id: 0,
          },
        ],
        has_more: false,
      })

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={onSelect}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))

    await waitFor(() => {
      expect(mockListDocuments).toHaveBeenNthCalledWith(1, 1, { limit: 200, offset: 0 })
      expect(mockListDocuments).toHaveBeenNthCalledWith(2, 1, { limit: 200, offset: 200 })
    })

    fireEvent.change(screen.getByTestId('context-selector-knowledge-search-input'), {
      target: { value: 'Beyond' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-201')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-document-node-document-201'))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        type: 'knowledge_base',
        scope_restricted: true,
        document_ids: [201],
        document_names: ['Beyond First Page.md'],
      })
    )
  })

  it('renders DingTalk docs inside the knowledge source picker with a virtual all-docs container', async () => {
    const onSelectMultiple = jest.fn()
    mockGetDingTalkDocs.mockResolvedValue({
      total_count: 2,
      nodes: [
        {
          id: 1,
          dingtalk_node_id: 'folder-1',
          name: '视频转码',
          doc_url: 'https://alidocs.dingtalk.com/i/nodes/folder-1',
          parent_node_id: '',
          node_type: 'folder',
          workspace_id: 'workspace-1',
          content_type: '',
          source: 'docs',
          is_active: true,
          last_synced_at: '',
          created_at: '',
          updated_at: '',
          children: [
            {
              id: 2,
              dingtalk_node_id: 'file-1',
              name: '任务执行流程',
              doc_url: 'https://alidocs.dingtalk.com/i/nodes/file-1',
              parent_node_id: 'folder-1',
              node_type: 'file',
              workspace_id: 'workspace-1',
              content_type: 'ALIDOC',
              source: 'docs',
              is_active: true,
              last_synced_at: '',
              created_at: '',
              updated_at: '',
              children: [],
            },
          ],
        },
      ],
    })

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        onSelectMultiple={onSelectMultiple}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-parent')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-parent'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-docs')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-docs'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-all-docs')).toBeInTheDocument()
      expect(screen.getByTestId('knowledge-picker-dingtalk-node-docs-folder-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-node-docs-folder-1'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'docs:folder-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'docs:file-1', type: 'dingtalk_doc' }),
    ])

    onSelectMultiple.mockClear()
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-all-docs'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'docs:folder-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'docs:file-1', type: 'dingtalk_doc' }),
    ])
  })

  it('renders DingTalk wikispace names in the second column, supports selecting a space, and opens children in the third column', async () => {
    const onSelectMultiple = jest.fn()
    mockGetDingTalkWikispaceNodes.mockResolvedValue({
      total_count: 2,
      nodes: [
        {
          id: 10,
          dingtalk_node_id: 'space-1',
          name: '视频业务研发',
          doc_url: 'https://alidocs.dingtalk.com/i/spaces/space-1/overview',
          parent_node_id: '',
          node_type: 'folder',
          workspace_id: 'space-1',
          content_type: '',
          source: 'wikispace',
          is_active: true,
          last_synced_at: '',
          created_at: '',
          updated_at: '',
          children: [
            {
              id: 11,
              dingtalk_node_id: 'wiki-file-1',
              name: '研发文档',
              doc_url: 'https://alidocs.dingtalk.com/i/nodes/wiki-file-1',
              parent_node_id: 'space-1',
              node_type: 'file',
              workspace_id: 'space-1',
              content_type: 'ALIDOC',
              source: 'wikispace',
              is_active: true,
              last_synced_at: '',
              created_at: '',
              updated_at: '',
              children: [],
            },
          ],
        },
      ],
    })

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        onSelectMultiple={onSelectMultiple}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-parent')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-parent'))
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-wikispace'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-space-space-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-space-space-1'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'wikispace:space-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'wikispace:wiki-file-1', type: 'dingtalk_doc' }),
    ])

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-dingtalk-node-wikispace-wiki-file-1')
      ).toBeInTheDocument()
    })
  })

  it('auto-expands the folder path for selected internal documents', async () => {
    mockGetFolderTree.mockResolvedValue([
      {
        id: 10,
        name: 'Specs',
        children: [
          {
            id: 11,
            name: 'API',
            children: [],
          },
        ],
      },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        {
          id: 101,
          name: 'API.md',
          folder_id: 11,
        },
      ],
    })

    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[
          {
            id: 1,
            name: 'Org KB',
            type: 'knowledge_base',
            document_ids: [101],
            scope_restricted: true,
          },
        ]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-101')).toBeInTheDocument()
    })
    expect(screen.getByText('Specs / API')).toBeInTheDocument()
  })
})
