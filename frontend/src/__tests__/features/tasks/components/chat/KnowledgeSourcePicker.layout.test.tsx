// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import {
  KnowledgeSourcePicker,
  type GroupedKnowledgeBases,
} from '@/features/tasks/components/chat/KnowledgeSourcePicker'

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const groupedKnowledgeBases: GroupedKnowledgeBases = {
  personal: [],
  group: new Map(),
  organization: [],
}

function renderPicker(layout?: 'self-contained' | 'fill-parent') {
  render(
    <div className="flex h-[400px] min-h-0 flex-col">
      <KnowledgeSourcePicker
        groupedKnowledgeBases={groupedKnowledgeBases}
        boundKnowledgeBases={[]}
        externalSources={[]}
        selectedContexts={[]}
        searchValue=""
        loading={false}
        error={null}
        onRetry={jest.fn()}
        onSelect={jest.fn()}
        onDeselect={jest.fn()}
        layout={layout}
      />
    </div>
  )

  return screen.getByTestId('knowledge-source-picker')
}

describe('KnowledgeSourcePicker layout', () => {
  it('keeps the self-contained Radix height calculation by default', () => {
    const picker = renderPicker()

    expect(picker).not.toHaveClass('flex-1', 'h-full')
    expect(picker).toHaveStyle(
      'height: min(520px, calc(var(--radix-popover-content-available-height) - 72px))'
    )
  })

  it('fills a constrained parent without applying the Radix height calculation', () => {
    const picker = renderPicker('fill-parent')

    expect(picker).toHaveClass('flex-1', 'min-h-0', 'h-full')
    expect(picker.style.height).toBe('')
  })
})
