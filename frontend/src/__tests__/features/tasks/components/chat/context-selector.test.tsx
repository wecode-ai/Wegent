// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'
import type { ContextItem } from '@/types/context'
import type { ExternalKbNode } from '@/types/external-knowledge'

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
const mockSyncDingTalkDocs = jest.fn()
const mockSyncDingTalkWikispaceNodes = jest.fn()

interface MockDingTalkNode {
  dingtalk_node_id: string
  name: string
  node_type: string
  parent_node_id?: string
  workspace_id?: string
  source?: string
  children?: MockDingTalkNode[]
}

interface MockDingTalkTree {
  nodes: MockDingTalkNode[]
}

interface MockExternalKnowledgeBase {
  knowledge_base_id: string
  knowledge_base_name: string
  scope?: string
}

function countMockDingTalkDocuments(nodes: MockDingTalkNode[]): number {
  return nodes.reduce((total, node) => {
    const self = node.node_type === 'folder' ? 0 : 1
    return total + self + countMockDingTalkDocuments(node.children ?? [])
  }, 0)
}

function toMockExternalNode(node: MockDingTalkNode): ExternalKbNode {
  return {
    node_id: node.dingtalk_node_id,
    raw_id: node.dingtalk_node_id,
    name: node.name,
    node_type: node.node_type === 'folder' ? 'folder' : 'document',
    parent_id: node.parent_node_id || null,
    children: (node.children ?? []).map(toMockExternalNode),
    source_type: node.source,
  }
}

const mockDingTalkExternalSource = {
  providerId: 'dingtalk',
  label: 'DingTalk',
  capabilities: {
    enforcesPerUserAccess: true,
    supportsAgentDefault: true,
    supportsKnowledgeBaseSelection: true,
    supportsDocumentSelection: true,
    supportsDocumentTree: true,
    supportsSyncStatus: true,
  },
  scopes: [
    { key: 'personal', label: 'DingTalk Docs', icon: 'personal' },
    { key: 'organization', label: 'DingTalk Knowledge Bases', icon: 'organization' },
  ],
  getKnowledgeBaseDisplay: (kb: MockExternalKnowledgeBase) =>
    kb.knowledge_base_id === 'docs'
      ? {
          labelKey: 'chat:dingtalkDocs.allDocs',
          icon: 'folderOpen',
          rowVariant: 'primary',
          testId: 'knowledge-picker-dingtalk-all-docs',
        }
      : undefined,
  listKnowledgeBases: async (params: { scope?: string } = {}) => {
    const [docsTree, docsStatus, wikispaceTree, wikispaceStatus] = await Promise.all([
      mockGetDingTalkDocs(),
      mockGetDingTalkSyncStatus(),
      mockGetDingTalkWikispaceNodes(),
      mockGetDingTalkWikispaceSyncStatus(),
    ] as const)
    const typedDocsTree = docsTree as MockDingTalkTree
    const typedWikispaceTree = wikispaceTree as MockDingTalkTree
    const items = []
    if (
      docsStatus.is_configured &&
      typedDocsTree.nodes.length > 0 &&
      (params.scope === undefined || params.scope === 'all' || params.scope === 'personal')
    ) {
      items.push({
        provider: 'dingtalk',
        knowledge_base_id: 'docs',
        knowledge_base_name: 'DingTalk Docs',
        scope: 'personal',
        document_count: countMockDingTalkDocuments(typedDocsTree.nodes),
      })
    }
    if (
      wikispaceStatus.is_configured &&
      (params.scope === undefined || params.scope === 'all' || params.scope === 'organization')
    ) {
      items.push(
        ...typedWikispaceTree.nodes.map((node: MockDingTalkNode) => ({
          provider: 'dingtalk',
          knowledge_base_id: node.workspace_id || node.dingtalk_node_id,
          knowledge_base_name: node.name,
          scope: 'organization',
          document_count: countMockDingTalkDocuments(node.children ?? []),
        }))
      )
    }
    return { items, total: items.length, has_more: false }
  },
  getKnowledgeBaseCount: async () => 2,
  getScopeStatuses: async () => {
    const [docsTree, docsStatus, wikispaceTree, wikispaceStatus] = await Promise.all([
      mockGetDingTalkDocs(),
      mockGetDingTalkSyncStatus(),
      mockGetDingTalkWikispaceNodes(),
      mockGetDingTalkWikispaceSyncStatus(),
    ] as const)
    const typedDocsTree = docsTree as MockDingTalkTree
    const typedWikispaceTree = wikispaceTree as MockDingTalkTree
    return [
      {
        key: 'personal',
        configured: Boolean(docsStatus.is_configured),
        synced: typedDocsTree.nodes.length > 0,
        lastSyncedAt: docsStatus.last_synced_at,
        messageKey: docsStatus.is_configured
          ? 'chat:dingtalkDocs.empty'
          : 'chat:dingtalkDocs.notConfigured',
      },
      {
        key: 'organization',
        configured: Boolean(wikispaceStatus.is_configured),
        synced: typedWikispaceTree.nodes.length > 0,
        lastSyncedAt: wikispaceStatus.last_synced_at,
        messageKey: wikispaceStatus.is_configured
          ? 'chat:dingtalkDocs.wikispaceEmpty'
          : 'chat:dingtalkDocs.wikispaceNotConfigured',
      },
    ]
  },
  syncScope: async (scope: string) => {
    if (scope === 'organization') {
      await mockSyncDingTalkWikispaceNodes()
      return
    }
    await mockSyncDingTalkDocs()
  },
  listNodes: async (knowledgeBaseId: string) => {
    if (knowledgeBaseId === 'docs') {
      const tree = (await mockGetDingTalkDocs()) as MockDingTalkTree
      return {
        items: tree.nodes.map(toMockExternalNode),
        total: tree.nodes.length,
        has_more: false,
      }
    }
    const tree = (await mockGetDingTalkWikispaceNodes()) as MockDingTalkTree
    const root = tree.nodes.find(
      (node: MockDingTalkNode) => (node.workspace_id || node.dingtalk_node_id) === knowledgeBaseId
    )
    const items = (root?.children ?? []).map(toMockExternalNode)
    return { items, total: items.length, has_more: false }
  },
  toRef: (kb: MockExternalKnowledgeBase) => ({
    provider: 'dingtalk',
    mode: 'explicit',
    id: kb.knowledge_base_id,
    name: kb.knowledge_base_name,
    scope: kb.scope,
    target_type: 'knowledge_base',
  }),
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: { children: React.ReactNode; href?: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
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
    syncDocs: (...args: unknown[]) => mockSyncDingTalkDocs(...args),
    syncWikispaceNodes: (...args: unknown[]) => mockSyncDingTalkWikispaceNodes(...args),
  },
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => [mockDingTalkExternalSource],
}))

jest.mock('@/features/knowledge/document/extension-loader', () => ({
  loadKBExtensions: jest.fn().mockResolvedValue(undefined),
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
    jest.clearAllMocks()
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
    mockSyncDingTalkDocs.mockResolvedValue({ added: 0, updated: 0, deleted: 0, total: 0 })
    mockSyncDingTalkWikispaceNodes.mockResolvedValue({
      added: 0,
      updated: 0,
      deleted: 0,
      total: 0,
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
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))
      await Promise.resolve()
    })

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
    await waitFor(() => {
      expect(screen.getByText('picker.emptyDocuments')).toBeInTheDocument()
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

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-picker-kb-77'))
      await Promise.resolve()
    })
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 77,
        name: 'Bound KB',
        type: 'knowledge_base',
      })
    )
    await waitFor(() => {
      expect(screen.getByText('picker.emptyDocuments')).toBeInTheDocument()
    })
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

  it('selects internal folders as first-class knowledge scope', async () => {
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
      expect(screen.getByTestId('knowledge-picker-folder-scope-10')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-folder-scope-10'))

    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 1,
          type: 'knowledge_base',
          scope_restricted: true,
          folder_ids: [10],
          folder_names: ['Specs'],
          include_subfolders: true,
        }),
      ])
    })
  })

  it('marks folder-covered child documents as inherited and non-toggleable', async () => {
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
      expect(screen.getByTestId('knowledge-picker-folder-scope-10')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-folder-scope-10'))

    const childDocument = screen.getByTestId('knowledge-picker-document-node-document-101')
    expect(childDocument).toBeDisabled()
    fireEvent.click(childDocument)

    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([
        expect.objectContaining({
          folder_ids: [10],
          document_ids: undefined,
        }),
      ])
    })
  })

  it('selects internal folders from search results', async () => {
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
    fireEvent.change(screen.getByTestId('context-selector-knowledge-search-input'), {
      target: { value: 'Specs' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-search-folder-10')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-search-folder-10'))

    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 1,
          type: 'knowledge_base',
          scope_restricted: true,
          folder_ids: [10],
          folder_names: ['Specs'],
          include_subfolders: true,
        }),
      ])
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
    expect(screen.getAllByText('Specs').length).toBeGreaterThan(0)
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

  it('constrains the internal document column so long document lists can scroll', async () => {
    mockGetFolderTree.mockResolvedValue([])
    mockListDocuments.mockResolvedValue({
      items: Array.from({ length: 30 }, (_, index) => ({
        id: index + 1,
        name: `Long Document ${index + 1}.md`,
        folder_id: 0,
      })),
      has_more: false,
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
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-1')).toBeInTheDocument()
    })

    const firstDocumentRow = screen.getByTestId('knowledge-picker-document-node-document-1')
    const scrollContainer = firstDocumentRow.parentElement?.parentElement
    const documentColumn = scrollContainer?.parentElement

    expect(scrollContainer).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    expect(documentColumn).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col')
  })

  it('renders DingTalk docs inside the knowledge source picker with a virtual all-docs container', async () => {
    const onSelect = jest.fn()
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
        onSelect={onSelect}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-personal'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-all-docs')).toBeInTheDocument()
    })
    expect(screen.getByText('chat:dingtalkDocs.allDocs')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-all-docs'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'external:dingtalk:explicit:docs',
        type: 'external_knowledge',
        ref: expect.objectContaining({ provider: 'dingtalk', id: 'docs' }),
      })
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-external-node-folder-1')).toBeInTheDocument()
      expect(screen.getByTestId('knowledge-picker-external-node-file-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-external-node-file-1'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'external:dingtalk:explicit:docs:document:file-1',
        type: 'external_knowledge',
        ref: expect.objectContaining({
          provider: 'dingtalk',
          id: 'docs',
          target_type: 'document',
          node_id: 'file-1',
        }),
      })
    )
  })

  it('shows the DingTalk docs sync toolbar and routes sync to docs only', async () => {
    let resolveSync: (value: unknown) => void = () => undefined
    mockSyncDingTalkDocs.mockReturnValueOnce(
      new Promise(resolve => {
        resolveSync = resolve
      })
    )
    mockGetDingTalkDocs.mockResolvedValue({
      total_count: 1,
      nodes: [
        {
          id: 1,
          dingtalk_node_id: 'file-1',
          name: '任务执行流程',
          doc_url: 'https://alidocs.dingtalk.com/i/nodes/file-1',
          parent_node_id: '',
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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-personal'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-scope-sync-toolbar-dingtalk-personal')
      ).toBeInTheDocument()
    })
    expect(screen.getByText('dingtalkDocs.neverSynced')).toBeInTheDocument()

    fireEvent.click(
      screen.getByTestId('knowledge-picker-external-scope-sync-button-dingtalk-personal')
    )
    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-scope-sync-button-dingtalk-personal')
      ).toHaveTextContent('dingtalkDocs.syncing')
    })

    expect(mockSyncDingTalkDocs).toHaveBeenCalledTimes(1)
    expect(mockSyncDingTalkWikispaceNodes).not.toHaveBeenCalled()

    await act(async () => {
      resolveSync({ added: 0, updated: 0, deleted: 0, total: 0 })
      await Promise.resolve()
    })
  })

  it('shows the DingTalk wikispace sync toolbar and routes sync to wikispace only', async () => {
    mockGetDingTalkWikispaceSyncStatus.mockResolvedValue({
      is_configured: true,
      last_synced_at: '2026-07-08T00:00:00Z',
      total_nodes: 1,
    })
    mockGetDingTalkWikispaceNodes.mockResolvedValue({
      total_count: 1,
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
          children: [],
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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-scope-sync-toolbar-dingtalk-organization')
      ).toBeInTheDocument()
    })
    expect(screen.getByText('dingtalkDocs.lastSynced')).toBeInTheDocument()

    fireEvent.click(
      screen.getByTestId('knowledge-picker-external-scope-sync-button-dingtalk-organization')
    )

    await waitFor(() => {
      expect(mockSyncDingTalkWikispaceNodes).toHaveBeenCalledTimes(1)
    })
    expect(mockSyncDingTalkDocs).not.toHaveBeenCalled()
  })

  it('keeps the configured-empty DingTalk docs CTA wired to docs sync', async () => {
    mockGetDingTalkDocs.mockResolvedValue({ nodes: [], total_count: 0 })

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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-personal'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-scope-empty-sync-button-dingtalk-personal')
      ).toBeInTheDocument()
    })
    expect(screen.getByText('chat:dingtalkDocs.empty')).toBeInTheDocument()

    fireEvent.click(
      screen.getByTestId('knowledge-picker-external-scope-empty-sync-button-dingtalk-personal')
    )
    await waitFor(() => {
      expect(mockSyncDingTalkDocs).toHaveBeenCalledTimes(1)
    })
    expect(mockSyncDingTalkWikispaceNodes).not.toHaveBeenCalled()
  })

  it('keeps the configured-empty DingTalk wikispace CTA wired to wikispace sync', async () => {
    mockGetDingTalkWikispaceNodes.mockResolvedValue({ nodes: [], total_count: 0 })

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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))

    await waitFor(() => {
      expect(
        screen.getByTestId(
          'knowledge-picker-external-scope-empty-sync-button-dingtalk-organization'
        )
      ).toBeInTheDocument()
    })
    expect(screen.getByText('chat:dingtalkDocs.wikispaceEmpty')).toBeInTheDocument()

    fireEvent.click(
      screen.getByTestId('knowledge-picker-external-scope-empty-sync-button-dingtalk-organization')
    )
    await waitFor(() => {
      expect(mockSyncDingTalkWikispaceNodes).toHaveBeenCalledTimes(1)
    })
    expect(mockSyncDingTalkDocs).not.toHaveBeenCalled()
  })

  it('shows configure for an unconfigured DingTalk docs scope without a sync button', async () => {
    mockGetDingTalkSyncStatus.mockResolvedValue({
      is_configured: false,
      last_synced_at: null,
      total_nodes: 0,
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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-personal'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-scope-configure-link-dingtalk-personal')
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByTestId('knowledge-picker-external-scope-sync-button-dingtalk-personal')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('knowledge-picker-external-scope-empty-sync-button-dingtalk-personal')
    ).not.toBeInTheDocument()
  })

  it('retries DingTalk catalog loading without invoking sync', async () => {
    mockGetDingTalkDocs.mockRejectedValueOnce(new Error('catalog failed')).mockResolvedValue({
      nodes: [],
      total_count: 0,
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
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-personal'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-dingtalk-catalog-retry-button')
      ).toBeInTheDocument()
    })

    const callsBeforeRetry = mockGetDingTalkDocs.mock.calls.length
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-catalog-retry-button'))
    await waitFor(() => {
      expect(mockGetDingTalkDocs.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
    })
    expect(mockSyncDingTalkDocs).not.toHaveBeenCalled()
    expect(mockSyncDingTalkWikispaceNodes).not.toHaveBeenCalled()
  })

  it('renders DingTalk wikispace names in the second column, supports selecting a space, and opens children in the third column', async () => {
    const onSelect = jest.fn()
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
        onSelect={onSelect}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-external:dingtalk')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-source-external:dingtalk'))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-external-kb-space-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-external-kb-space-1'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'external:dingtalk:explicit:space-1',
        type: 'external_knowledge',
        ref: expect.objectContaining({ provider: 'dingtalk', id: 'space-1' }),
      })
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-external-node-wiki-file-1')).toBeInTheDocument()
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
