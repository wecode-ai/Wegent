// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdvancedKnowledgeToggle } from '@/features/knowledge/document/components/AdvancedKnowledgeToggle'
import {
  filterKnowledgeBasesByAdvancedMode,
  hasAdvancedKnowledgeBases,
  useAdvancedKnowledgeMode,
} from '@/features/knowledge/document/hooks/useAdvancedKnowledgeMode'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function AdvancedKnowledgeModeHarness() {
  const { showAdvancedKnowledge, setShowAdvancedKnowledge } = useAdvancedKnowledgeMode()

  return (
    <AdvancedKnowledgeToggle
      id="show-advanced-knowledge-test"
      testId="show-advanced-knowledge-test-toggle"
      checked={showAdvancedKnowledge}
      onCheckedChange={setShowAdvancedKnowledge}
    />
  )
}

describe('advanced knowledge mode', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('calls the hook setter and persists when clicked', async () => {
    const user = userEvent.setup()
    render(<AdvancedKnowledgeModeHarness />)

    const toggle = screen.getByTestId('show-advanced-knowledge-test-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('wegent_show_advanced_knowledge')).toBe('true')
  })

  it('filters code wikis only when advanced mode is hidden', () => {
    const knowledgeBases = [{ kb_type: 'notebook' as const }, { kb_type: 'code_wiki' as const }]

    expect(hasAdvancedKnowledgeBases(knowledgeBases)).toBe(true)
    expect(filterKnowledgeBasesByAdvancedMode(knowledgeBases, false)).toEqual([knowledgeBases[0]])
    expect(filterKnowledgeBasesByAdvancedMode(knowledgeBases, true)).toEqual(knowledgeBases)
  })
})
