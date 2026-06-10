// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'

const mockListKnowledgeBases = jest.fn()
const mockGetOrganizationNamespace = jest.fn()
const translate = (key: string) => key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translate,
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
    list: jest.fn().mockResolvedValue({ items: [] }),
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

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('ContextSelector organization grouping', () => {
  beforeEach(() => {
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
  })

  it('shows organization knowledge bases after selecting the organization scope', async () => {
    const user = userEvent.setup()

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
      expect(screen.getByText('contextSelector.organizationKnowledge')).toBeInTheDocument()
    })

    await user.click(screen.getByText('contextSelector.organizationKnowledge'))
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
      expect(screen.getByText('contextSelector.organizationKnowledge')).toBeInTheDocument()
    })

    expect(screen.getByTestId('context-selector-popover')).toHaveAttribute('data-side', 'top')
  })
})
