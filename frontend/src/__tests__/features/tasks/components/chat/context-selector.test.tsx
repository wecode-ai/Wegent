// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import ContextSelectorBase from '@/features/tasks/components/chat/ContextSelector'
import type { ContextItem } from '@/types/context'

type ContextSelectorProps = ComponentProps<typeof ContextSelectorBase>

function ContextSelector({
  onReplaceContexts,
  ...props
}: Omit<ContextSelectorProps, 'onReplaceContexts'> & {
  onReplaceContexts?: ContextSelectorProps['onReplaceContexts']
}) {
  const replaceContexts =
    onReplaceContexts ??
    ((idsToRemove, contextsToAdd) => {
      idsToRemove.forEach(id => props.onDeselect(id))
      contextsToAdd.forEach(context => props.onSelect(context))
    })
  return <ContextSelectorBase {...props} onReplaceContexts={replaceContexts} />
}

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
let mockIsMobile = false

const mockT = (key: string, options?: { count?: number }) =>
  key === 'knowledge:picker.selectedCount' ? `${key}:${options?.count ?? 0}` : key
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => mockIsMobile,
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

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-selector-drawer">{children}</div>
  ),
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  TabsTrigger: ({
    children,
    value: _value,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) => (
    <button {...props}>{children}</button>
  ),
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
    mockIsMobile = false
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

  it('clears the knowledge-base search before showing its documents', async () => {
    mockListDocuments.mockResolvedValue({
      items: [
        {
          id: 21,
          name: 'Document.md',
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
    const search = screen.getByTestId('context-selector-knowledge-search-input')
    fireEvent.change(search, { target: { value: 'Org KB' } })
    fireEvent.click(await screen.findByTestId('knowledge-picker-kb-1'))

    await waitFor(() => {
      expect(search).toHaveValue('')
      expect(screen.getByTestId('knowledge-picker-document-node-document-21')).toBeInTheDocument()
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

  it('uses a bottom drawer on mobile while preserving knowledge and table access', async () => {
    mockIsMobile = true
    const onOpenChange = jest.fn()

    render(
      <ContextSelector
        open={true}
        onOpenChange={onOpenChange}
        selectedContexts={[
          {
            id: 'docs:file-1',
            name: 'DingTalk document',
            type: 'dingtalk_doc',
            doc_url: 'https://alidocs.dingtalk.com/i/nodes/file-1',
            node_type: 'file',
            dingtalk_node_id: 'file-1',
            source: 'docs',
          },
        ]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('context-selector-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('context-selector-knowledge-tab').querySelector('svg')).toHaveClass(
      'lucide-book-open'
    )
    expect(screen.getByTestId('context-selector-table-tab')).toBeInTheDocument()
    expect(screen.getByTestId('context-selector-selected-count')).toHaveTextContent(
      'knowledge:picker.selectedCount:1'
    )

    fireEvent.click(await screen.findByTestId('knowledge-picker-dingtalk-parent'))
    expect(
      screen.getByTestId('knowledge-picker-responsive-dingtalk-wikispace').querySelector('svg')
    ).toHaveClass('lucide-book-open')

    fireEvent.click(screen.getByTestId('context-selector-done-button'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([
    ['notebook', 'lucide-book-open', 'text-primary'],
    ['classic', 'lucide-database', 'text-text-secondary'],
    ['code_wiki', 'lucide-code-xml', 'text-primary'],
  ] as const)(
    'shows the %s icon and keeps navigation separate from selection',
    async (kbType, icon, color) => {
      const onSelect = jest.fn()
      mockGetAllGroupedKnowledgeBases.mockResolvedValue(
        createAllGroupedResponse({
          organization: [
            {
              ...createGroupedKnowledgeBase({ id: 1, name: 'Org KB', namespace: 'acme-corp' }),
              kb_type: kbType,
            },
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
      expect(
        screen.getByRole('button', { name: 'knowledge:title' }).querySelector('svg')
      ).toHaveClass('lucide-book-open', 'w-3.5', 'h-3.5')
      expect(screen.getByTestId('knowledge-picker-kb-1').querySelector('svg')).toHaveClass(
        icon,
        color,
        'h-4',
        'w-4'
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))
        await Promise.resolve()
      })

      expect(onSelect).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId('knowledge-picker-kb-select-1'))
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
    }
  )

  it('uses a drill-down document view on narrow screens', async () => {
    mockIsMobile = true
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

    expect(screen.getByTestId('knowledge-picker-source-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-knowledge-base-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-document-column')).toHaveClass('hidden')
    expect(screen.queryByTestId('knowledge-picker-mobile-back')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-1')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-1'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-column')).toHaveClass('hidden')
    })
    expect(screen.getByTestId('knowledge-picker-knowledge-base-column')).toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-document-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-mobile-back')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-mobile-back'))

    expect(screen.getByTestId('knowledge-picker-source-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-knowledge-base-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('knowledge-picker-document-column')).toHaveClass('hidden')
  })

  it('drills into group knowledge before showing knowledge bases on narrow screens', async () => {
    mockIsMobile = true
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
      expect(screen.getByTestId('knowledge-picker-responsive-group-options')).toBeInTheDocument()
    })
    expect(screen.getByTestId('knowledge-picker-responsive-group-dev-group')).toHaveTextContent(
      'Dev Experience'
    )
    expect(screen.queryByTestId('knowledge-picker-kb-2')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-picker-responsive-group-dev-group'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-kb-2')).toBeInTheDocument()
    })
    expect(screen.getByTestId('knowledge-picker-responsive-group-back')).toHaveTextContent(
      'Dev Experience'
    )

    fireEvent.click(screen.getByTestId('knowledge-picker-responsive-group-back'))
    expect(screen.getByTestId('knowledge-picker-responsive-group-dev-group')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-picker-kb-2')).not.toBeInTheDocument()
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

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-group')).toHaveTextContent('2')
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-group'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-group-empty-group')).toBeInTheDocument()
    })

    expect(screen.getByTestId('knowledge-picker-group-empty-group')).toHaveTextContent(
      'Empty Group'
    )
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
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('knowledge-picker-kb-select-77'))
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
      expect(screen.getByTestId('knowledge-picker-group-fallback-group')).toHaveTextContent(
        'fallback-group'
      )
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

  it('clears a folder when all descendants were selected individually', async () => {
    const onReplaceContexts = jest.fn()
    mockGetFolderTree.mockResolvedValue([
      {
        id: 10,
        name: 'Specs',
        children: [],
      },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        { id: 101, name: 'API.md', folder_id: 10 },
        { id: 102, name: 'Guide.md', folder_id: 10 },
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
            scope_restricted: true,
            document_ids: [101, 102],
            document_names: ['API.md', 'Guide.md'],
          },
        ]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        onReplaceContexts={onReplaceContexts}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-source-organization')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-source-organization'))
    fireEvent.click(await screen.findByTestId('knowledge-picker-kb-1'))

    const folderSelection = await screen.findByTestId('knowledge-picker-folder-scope-10')
    expect(folderSelection).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(folderSelection)

    expect(onReplaceContexts).toHaveBeenCalledWith([1], [])
  })

  it('preserves disjoint folder scopes when removing an effectively selected folder', async () => {
    const onReplaceContexts = jest.fn()
    mockGetFolderTree.mockResolvedValue([
      { id: 10, name: 'Specs', children: [] },
      { id: 20, name: 'Guides', children: [] },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        { id: 101, name: 'API.md', folder_id: 10 },
        { id: 102, name: 'Guide.md', folder_id: 20 },
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
            scope_restricted: true,
            folder_ids: [10, 20],
            folder_names: ['Specs', 'Guides'],
            include_subfolders: true,
          },
        ]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        onReplaceContexts={onReplaceContexts}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    fireEvent.click(await screen.findByTestId('knowledge-picker-source-organization'))
    fireEvent.click(await screen.findByTestId('knowledge-picker-kb-1'))
    fireEvent.click(await screen.findByTestId('knowledge-picker-folder-scope-10'))

    expect(onReplaceContexts).toHaveBeenCalledWith(
      [1],
      [
        expect.objectContaining({
          folder_ids: [20],
          folder_names: ['Guides'],
          include_subfolders: true,
          document_ids: undefined,
        }),
      ]
    )
  })

  it('expands a parent folder when removing one of its child folders', async () => {
    const onReplaceContexts = jest.fn()
    mockGetFolderTree.mockResolvedValue([
      {
        id: 10,
        name: 'Parent',
        children: [
          { id: 11, name: 'Keep', children: [] },
          { id: 12, name: 'Remove', children: [] },
        ],
      },
    ])
    mockListDocuments.mockResolvedValue({
      items: [
        { id: 101, name: 'Keep.md', folder_id: 11 },
        { id: 102, name: 'Remove.md', folder_id: 12 },
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
            scope_restricted: true,
            folder_ids: [10],
            folder_names: ['Parent'],
            include_subfolders: true,
          },
        ]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        onReplaceContexts={onReplaceContexts}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    fireEvent.click(await screen.findByTestId('knowledge-picker-source-organization'))
    fireEvent.click(await screen.findByTestId('knowledge-picker-kb-1'))
    fireEvent.click(await screen.findByTestId('knowledge-picker-folder-scope-12'))

    expect(onReplaceContexts).toHaveBeenCalledWith(
      [1],
      [
        expect.objectContaining({
          folder_ids: undefined,
          document_ids: [101],
          document_names: ['Keep.md'],
        }),
      ]
    )
  })

  it('allows removing a child document from an inherited folder selection', async () => {
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
    expect(childDocument).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(childDocument)

    await waitFor(() => {
      expect(contextChanges).toHaveBeenLastCalledWith([])
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
          file_extension: '.PDF',
          source_type: 'external',
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

    expect(
      screen.getByTestId('knowledge-picker-document-node-document-101').querySelector('svg')
    ).toHaveClass('lucide-file-text', 'text-error')

    fireEvent.change(screen.getByTestId('context-selector-knowledge-search-input'), {
      target: { value: 'Specs' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-document-node-document-101')).toBeInTheDocument()
    })
    expect(screen.getByText('API.md')).toBeInTheDocument()
    expect(
      screen.getByTestId('knowledge-picker-document-node-document-101').querySelector('svg')
    ).toHaveClass('lucide-file-text', 'text-error')
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
    const onSelectMultiple = jest.fn()
    mockGetDingTalkDocs.mockResolvedValue({
      total_count: 3,
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
        {
          id: 3,
          dingtalk_node_id: 'file-2',
          name: '预算说明',
          doc_url: 'https://alidocs.dingtalk.com/i/nodes/file-2',
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

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-node-select-docs-folder-1'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'docs:folder-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'docs:file-1', type: 'dingtalk_doc' }),
    ])

    onSelectMultiple.mockClear()
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-all-docs-select'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'docs:folder-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'docs:file-1', type: 'dingtalk_doc' }),
      expect.objectContaining({ id: 'docs:file-2', type: 'dingtalk_doc' }),
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
    const wikiSource = screen.getByTestId('knowledge-picker-dingtalk-wikispace')
    expect(wikiSource.querySelector('svg')).toHaveClass('lucide-book-open', 'text-text-muted')
    fireEvent.click(wikiSource)
    expect(wikiSource.querySelector('svg')).toHaveClass('lucide-book-open', 'text-primary')
    expect(wikiSource.querySelector('svg')).not.toHaveClass('text-text-muted')

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-space-space-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-space-space-1'))
    expect(onSelectMultiple).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-dingtalk-space-select-space-1')
      ).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-space-select-space-1'))
    expect(onSelectMultiple).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'wikispace:space-1',
        type: 'dingtalk_doc',
        workspace_id: 'space-1',
        workspace_name: '视频业务研发',
      }),
      expect.objectContaining({
        id: 'wikispace:wiki-file-1',
        type: 'dingtalk_doc',
        workspace_id: 'space-1',
        workspace_name: '视频业务研发',
      }),
    ])

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-dingtalk-node-wikispace-wiki-file-1')
      ).toBeInTheDocument()
    })
  })

  it('keeps DingTalk wikispace usable when internal knowledge bases fail to load', async () => {
    mockGetAllGroupedKnowledgeBases.mockRejectedValueOnce(
      new Error('internal knowledge bases unavailable')
    )
    mockGetDingTalkWikispaceNodes.mockResolvedValue({
      total_count: 1,
      nodes: [
        {
          id: 10,
          dingtalk_node_id: 'space-1',
          name: '研发空间',
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
      expect(screen.getByTestId('knowledge-picker-dingtalk-parent')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-parent'))
    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-wikispace'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-picker-dingtalk-space-space-1')).toBeInTheDocument()
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
