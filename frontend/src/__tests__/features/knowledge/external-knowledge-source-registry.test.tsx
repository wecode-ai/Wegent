// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

import { registerExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'
import type { ContextItem } from '@/types/context'
import type { ExternalKbNode, ExternalKnowledgeBase } from '@/types/external-knowledge'

const mockListKnowledgeBases = jest.fn()
const mockGetAllGroupedKnowledgeBases = jest.fn()
const mockGetOrganizationNamespace = jest.fn()
const mockUseKnowledgeBaseOptions = jest.fn()
const mockListFakeKnowledgeBases = jest.fn()
const mockListFakeNodes = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
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
}))

jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: {
    getBoundKnowledgeBases: jest.fn().mockResolvedValue({ items: [] }),
  },
}))

jest.mock('@/apis/table', () => ({
  tableApi: { list: jest.fn().mockResolvedValue({ items: [] }) },
}))

jest.mock('@/features/settings/hooks/useKnowledgeBaseOptions', () => ({
  useKnowledgeBaseOptions: () => mockUseKnowledgeBaseOptions(),
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
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

const FAKE_PROVIDER = 'fake-provider'
const FAKE_KB: ExternalKnowledgeBase = {
  provider: FAKE_PROVIDER,
  knowledge_base_id: 'lib-1',
  knowledge_base_name: 'Fake Lib',
  scope: 'organization',
  document_count: 3,
}

function makeFakeKb(index: number): ExternalKnowledgeBase {
  return {
    provider: FAKE_PROVIDER,
    knowledge_base_id: `lib-${index}`,
    knowledge_base_name: `Fake Lib ${index}`,
    scope: 'organization',
    document_count: 1,
  }
}

function makeFakeDocument(index: number): ExternalKbNode {
  return {
    node_id: `document:doc-${index}`,
    raw_id: `doc-${index}`,
    name: `Doc ${index}`,
    node_type: 'document',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  registerExternalKnowledgeSource(FAKE_PROVIDER, {
    providerId: FAKE_PROVIDER,
    label: 'Fake Provider',
    capabilities: {
      supportsKnowledgeBaseSelection: true,
      supportsDocumentSelection: true,
      supportsDocumentTree: true,
      supportsScopedRetrieval: false,
    },
    scopes: [
      {
        key: 'organization',
        label: 'Organization',
        icon: 'organization',
      },
    ],
    listKnowledgeBases: mockListFakeKnowledgeBases,
    listNodes: mockListFakeNodes,
    toRef: kb => ({
      provider: FAKE_PROVIDER,
      mode: 'explicit',
      id: kb.knowledge_base_id,
      name: kb.knowledge_base_name,
      scope: kb.scope ?? undefined,
    }),
  })
  mockListFakeKnowledgeBases.mockResolvedValue({ items: [FAKE_KB] })
  mockListFakeNodes.mockResolvedValue({
    items: [
      {
        node_id: 'document:doc-1',
        raw_id: 'doc-1',
        name: 'Doc 1',
        node_type: 'document',
      },
    ],
  })
  mockListKnowledgeBases.mockResolvedValue({ items: [] })
  mockGetAllGroupedKnowledgeBases.mockResolvedValue({
    personal: {
      created_by_me: [],
      shared_with_me: [],
    },
    groups: [],
    organization: {
      namespace: 'acme-corp',
      display_name: 'Acme Corp',
      kb_count: 0,
      knowledge_bases: [],
    },
    summary: {
      total_count: 0,
      personal_count: 0,
      group_count: 0,
      organization_count: 0,
    },
  })
  mockGetOrganizationNamespace.mockResolvedValue({ namespace: 'acme-corp' })
  mockUseKnowledgeBaseOptions.mockReturnValue({ options: [], loading: false, error: null })
})

describe('external knowledge source registry — ContextSelector (conversation)', () => {
  it('renders browse-capable providers through the three-column picker', async () => {
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
      expect(
        screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`)
      ).toBeInTheDocument()
    })
    expect(screen.getByText('Fake Provider')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`))
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-scope-organization')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))

    await waitFor(() => {
      expect(mockListFakeKnowledgeBases).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'organization' })
      )
    })
    expect(await screen.findByTestId('knowledge-picker-external-kb-lib-1')).toBeInTheDocument()
  })

  it('pages through all external knowledge bases for the active scope', async () => {
    mockListFakeKnowledgeBases.mockImplementation((params?: { offset?: number }) =>
      Promise.resolve({
        items:
          params?.offset === 0
            ? Array.from({ length: 100 }, (_, index) => makeFakeKb(index))
            : [makeFakeKb(100)],
        has_more: params?.offset === 0,
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

    await waitFor(() =>
      expect(
        screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`)
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))

    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-kb-lib-100')).toBeInTheDocument()
    )
    expect(mockListFakeKnowledgeBases).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 100, offset: 0 })
    )
    expect(mockListFakeKnowledgeBases).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 100, offset: 100 })
    )
  })

  it('pages through all external nodes when opening a knowledge base', async () => {
    mockListFakeNodes.mockImplementation((_knowledgeBaseId: string, params?: { offset?: number }) =>
      Promise.resolve({
        items:
          params?.offset === 0
            ? Array.from({ length: 500 }, (_, index) => makeFakeDocument(index))
            : [makeFakeDocument(500)],
        has_more: params?.offset === 0,
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

    await waitFor(() =>
      expect(
        screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`)
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-kb-lib-1')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('knowledge-picker-external-kb-lib-1'))

    await waitFor(() =>
      expect(
        screen.getByTestId('knowledge-picker-external-node-document:doc-500')
      ).toBeInTheDocument()
    )
    expect(mockListFakeNodes).toHaveBeenNthCalledWith(
      1,
      'lib-1',
      expect.objectContaining({ recursive: true, limit: 500, offset: 0 })
    )
    expect(mockListFakeNodes).toHaveBeenNthCalledWith(
      2,
      'lib-1',
      expect.objectContaining({ recursive: true, limit: 500, offset: 500 })
    )
  })

  it('writes a full ExternalKnowledgeRef (incl. mode/scope) onto the selectedContexts channel', async () => {
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

    await waitFor(() =>
      expect(
        screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`)
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`))
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-scope-organization')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-kb-lib-1')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('knowledge-picker-external-kb-lib-1'))

    await waitFor(() => {
      expect(
        screen.getByTestId('knowledge-picker-external-node-document:doc-1')
      ).toBeInTheDocument()
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'external_knowledge',
        id: 'external:fake-provider:explicit:lib-1',
        name: 'Fake Lib',
        ref: {
          provider: FAKE_PROVIDER,
          mode: 'explicit',
          id: 'lib-1',
          name: 'Fake Lib',
          scope: 'organization',
        },
      })
    )
  })

  it('keeps whole-KB and document refs mutually exclusive for external sources', async () => {
    const onChange = jest.fn()

    function StatefulSelector() {
      const [contexts, setContexts] = useState<ContextItem[]>([])
      const updateContexts = (next: ContextItem[]) => {
        onChange(next)
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

    await waitFor(() =>
      expect(
        screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`)
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId(`knowledge-picker-source-external:${FAKE_PROVIDER}`))
    fireEvent.click(screen.getByTestId('knowledge-picker-external-scope-organization'))
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-picker-external-kb-lib-1')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('knowledge-picker-external-kb-lib-1'))
    await waitFor(() =>
      expect(
        screen.getByTestId('knowledge-picker-external-node-document:doc-1')
      ).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 'external:fake-provider:explicit:lib-1',
        }),
      ])
    )
    expect(onChange.mock.calls.at(-1)?.[0][0].ref.target_type).toBeUndefined()

    fireEvent.click(screen.getByTestId('knowledge-picker-external-node-document:doc-1'))
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 'external:fake-provider:explicit:lib-1:document:document:doc-1',
          ref: expect.objectContaining({
            target_type: 'document',
            node_id: 'document:doc-1',
            document_id: 'doc-1',
          }),
        }),
      ])
    )

    fireEvent.click(screen.getByTestId('knowledge-picker-external-kb-lib-1'))
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: 'external:fake-provider:explicit:lib-1',
          ref: expect.not.objectContaining({ target_type: 'document' }),
        }),
      ])
    )
  })
})
