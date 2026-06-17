// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'

const mockListKnowledgeBases = jest.fn()
const mockGetOrganizationNamespace = jest.fn()
const mockListTables = jest.fn()

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
  },
}))

jest.mock('@/apis/knowledge', () => ({
  getOrganizationNamespace: (...args: unknown[]) => mockGetOrganizationNamespace(...args),
}))

jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: {
    getBoundKnowledgeBases: jest.fn().mockResolvedValue({ items: [] }),
  },
}))

jest.mock('@/apis/table', () => ({
  tableApi: {
    list: (...args: unknown[]) => mockListTables(...args),
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

describe('ContextSelector organization grouping', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListKnowledgeBases.mockResolvedValue({
      items: [
        {
          id: 1,
          name: 'Org KB',
          namespace: 'acme-corp',
          description: 'Company docs',
          document_count: 3,
        },
      ],
    })
    mockGetOrganizationNamespace.mockResolvedValue({
      namespace: 'acme-corp',
    })
    mockListTables.mockResolvedValue({ items: [] })
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
      expect(screen.getByText('knowledge:document.tabs.organization')).toBeInTheDocument()
    })

    expect(screen.queryByText('knowledge:document.tabs.group')).not.toBeInTheDocument()
    expect(screen.getByText('Org KB')).toBeInTheDocument()
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
      expect(screen.getByText('knowledge:document.tabs.organization')).toBeInTheDocument()
    })

    expect(screen.getByTestId('context-selector-popover')).toHaveAttribute('data-side', 'top')
  })

  it('keeps the table tab available by default for chat contexts', async () => {
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

    expect(screen.getByText('knowledge:table.title')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockListTables).toHaveBeenCalled()
    })
  })

  it('falls back to default context types when allowed types are explicitly empty', async () => {
    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        allowedContextTypes={[]}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    expect(screen.getByText('knowledge:table.title')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockListKnowledgeBases).toHaveBeenCalled()
      expect(mockListTables).toHaveBeenCalled()
    })
  })

  it('hides table contexts when restricted to default agent context types', async () => {
    render(
      <ContextSelector
        open={true}
        onOpenChange={jest.fn()}
        selectedContexts={[]}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        allowedContextTypes={['knowledge_base', 'dingtalk_doc']}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    expect(screen.queryByText('knowledge:table.title')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockListKnowledgeBases).toHaveBeenCalled()
    })
    expect(mockListTables).not.toHaveBeenCalled()
  })

  it('filters knowledge bases by allowed sources and group namespaces', async () => {
    mockListKnowledgeBases.mockResolvedValue({
      items: [
        {
          id: 1,
          name: 'Personal KB',
          namespace: 'default',
          description: 'Private docs',
          document_count: 1,
        },
        {
          id: 2,
          name: 'Platform KB',
          namespace: 'platform',
          description: 'Platform docs',
          document_count: 2,
        },
        {
          id: 3,
          name: 'Growth KB',
          namespace: 'growth',
          description: 'Growth docs',
          document_count: 3,
        },
        {
          id: 4,
          name: 'Org KB',
          namespace: 'acme-corp',
          description: 'Company docs',
          document_count: 4,
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
        allowedContextTypes={['knowledge_base']}
        allowedKnowledgeBaseSources={['group', 'organization']}
        allowedGroupNamespaces={['platform']}
      >
        <button>trigger</button>
      </ContextSelector>
    )

    await waitFor(() => {
      expect(screen.getByText('Platform KB')).toBeInTheDocument()
      expect(screen.getByText('Org KB')).toBeInTheDocument()
    })
    expect(screen.queryByText('Personal KB')).not.toBeInTheDocument()
    expect(screen.queryByText('Growth KB')).not.toBeInTheDocument()
  })
})
