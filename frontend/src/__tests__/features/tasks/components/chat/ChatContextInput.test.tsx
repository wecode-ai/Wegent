// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import ChatContextInput from '@/features/tasks/components/chat/ChatContextInput'
import type { ContextItem } from '@/types/context'

jest.mock('@/lib/runtime-config', () => ({
  isChatContextEnabled: () => true,
}))

jest.mock('@/features/tasks/components/chat/AddContextButton', () => {
  const MockAddContextButton = ({ onClick }: { onClick: () => void }) => (
    <button data-testid="add-context-button" onClick={onClick}>
      add
    </button>
  )
  MockAddContextButton.displayName = 'MockAddContextButton'
  return MockAddContextButton
})

jest.mock('@/features/tasks/components/chat/ContextSelector', () => {
  const internalContext: ContextItem = {
    id: 107,
    name: '测试mcp',
    type: 'knowledge_base',
    document_count: 1,
  }
  const externalContext: ContextItem = {
    id: 'external:demo-source:explicit:e686dce5-93f0-4363-95e0-13d5f80b5abd',
    name: '测试1111',
    type: 'external_knowledge',
    ref: {
      provider: 'demo-source',
      mode: 'explicit',
      id: 'e686dce5-93f0-4363-95e0-13d5f80b5abd',
      name: '测试1111',
      scope: 'organization',
    },
  }

  const MockContextSelector = ({
    children,
    onSelect,
    onReplaceContexts,
    onOpenChange,
  }: {
    children: React.ReactNode
    onSelect: (context: ContextItem) => void
    onReplaceContexts?: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
    onOpenChange: (open: boolean) => void
  }) => (
    <div>
      {children}
      <button data-testid="select-internal" onClick={() => onSelect(internalContext)}>
        select internal
      </button>
      <button
        data-testid="select-external"
        onClick={() => onReplaceContexts?.([], [externalContext])}
      >
        select external
      </button>
      <button data-testid="close-selector" onClick={() => onOpenChange(false)}>
        close selector
      </button>
    </div>
  )
  MockContextSelector.displayName = 'MockContextSelector'
  return MockContextSelector
})

function ChatContextInputHarness() {
  const [contexts, setContexts] = useState<ContextItem[]>([])
  return (
    <div>
      <ChatContextInput selectedContexts={contexts} onContextsChange={setContexts} />
      <output data-testid="selected-contexts">
        {contexts.map(context => `${context.type}:${context.id}`).join('|')}
      </output>
    </div>
  )
}

describe('ChatContextInput', () => {
  it('notifies its parent when the selector opens and closes', () => {
    const onSelectorOpenChange = jest.fn()
    render(
      <ChatContextInput
        selectedContexts={[]}
        onContextsChange={jest.fn()}
        onSelectorOpenChange={onSelectorOpenChange}
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByTestId('close-selector'))
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('preserves internal and external selections made in the same render turn', () => {
    render(<ChatContextInputHarness />)

    fireEvent.click(screen.getByTestId('select-internal'))
    fireEvent.click(screen.getByTestId('select-external'))

    expect(screen.getByTestId('selected-contexts')).toHaveTextContent('knowledge_base:107')
    expect(screen.getByTestId('selected-contexts')).toHaveTextContent(
      'external_knowledge:external:demo-source:explicit:e686dce5-93f0-4363-95e0-13d5f80b5abd'
    )
  })
})
