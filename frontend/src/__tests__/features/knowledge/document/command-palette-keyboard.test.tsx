// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '@/features/knowledge/document/components/CommandPalette'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

it('keeps the keyboard-selected result visible and activates that result', async () => {
  const scroll = jest.spyOn(Element.prototype, 'scrollIntoView')
  const onSelectGroup = jest.fn()
  const onSelectKb = jest.fn()
  const libraries: KnowledgeBase[] = [1, 2].map(id => ({
    id,
    name: `Knowledge ${id}`,
    description: null,
    namespace: 'default',
    user_id: 1,
    document_count: 0,
    is_active: true,
    summary_enabled: false,
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 2,
    created_at: '2026-11-04T00:00:00Z',
    updated_at: '2026-11-04T00:00:00Z',
  }))
  try {
    render(
      <CommandPalette
        open
        onOpenChange={jest.fn()}
        onSelectKb={onSelectKb}
        onSelectGroup={onSelectGroup}
        allKnowledgeBases={libraries}
        allGroups={[
          {
            id: 'group-research',
            type: 'group',
            name: 'research',
            displayName: 'Knowledge team',
            kbCount: 2,
          },
        ]}
      />
    )
    const user = userEvent.setup()
    await user.type(screen.getByTestId('command-palette-input'), 'Knowledge')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scroll.mock.contexts.at(-1)).toBe(
      screen.getByTestId('search-result-group-group-research')
    )
    await user.keyboard('{ArrowUp}')
    expect(scroll.mock.contexts.at(-1)).toBe(screen.getByTestId('search-result-kb-2'))
    await user.keyboard('{Enter}')
    expect(onSelectKb).toHaveBeenCalledWith(libraries[1])
    expect(onSelectGroup).not.toHaveBeenCalled()
  } finally {
    scroll.mockRestore()
  }
})
