// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeContextSelector } from '@/features/tasks/components/chat/knowledge-context/knowledge-context-selector'
import type { KnowledgeBase } from '@/types/api'
import type { ContextItem } from '@/types/context'

const translate = (key: string) => key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('next/link', () => {
  const MockLink = ({ children }: { children: React.ReactNode }) => <a>{children}</a>
  MockLink.displayName = 'MockLink'
  return MockLink
})

function makeKnowledgeBase(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: 1,
    name: 'Knowledge Base',
    description: null,
    user_id: 1,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: false,
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderSelector() {
  function Wrapper() {
    const [selectedContexts, setSelectedContexts] = React.useState<ContextItem[]>([])

    return (
      <KnowledgeContextSelector
        knowledgeBases={[
          makeKnowledgeBase({ id: 1, name: 'Personal KB', namespace: 'default' }),
          makeKnowledgeBase({ id: 2, name: 'Org KB', namespace: 'org' }),
        ]}
        boundKnowledgeBases={[]}
        selectedContexts={selectedContexts}
        onSelect={context => setSelectedContexts(current => [...current, context])}
        onDeselect={id => setSelectedContexts(current => current.filter(ctx => ctx.id !== id))}
        onOpenChange={jest.fn()}
        organizationNamespace="org"
        isLoading={false}
        error={null}
        onRetry={jest.fn()}
      />
    )
  }

  return render(<Wrapper />)
}

describe('KnowledgeContextSelector', () => {
  it('keeps user-selected scope active after selecting a knowledge base in another scope', async () => {
    const user = userEvent.setup()

    renderSelector()

    expect(screen.getByTestId('knowledge-option-1')).toHaveTextContent('Personal KB')

    await user.click(screen.getByTestId('knowledge-option-1'))
    await user.click(screen.getByTestId('knowledge-scope-organization'))

    expect(screen.getByTestId('knowledge-option-2')).toHaveTextContent('Org KB')
    expect(screen.queryByTestId('knowledge-option-1')).not.toBeInTheDocument()
  })
})
