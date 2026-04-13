// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'

import { PromptDraftComparisonPanel } from '@/features/prompt-draft/components/PromptDraftComparisonPanel'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('PromptDraftComparisonPanel', () => {
  test('renders previous and next prompts with diff summary and decision buttons', () => {
    const onKeepOld = jest.fn()
    const onUseNew = jest.fn()

    render(
      <PromptDraftComparisonPanel
        previousVersion={{
          id: 'v1',
          title: '旧版',
          prompt: 'line-1\nline-2\nline-3',
          model: 'model-a',
          version: 1,
          createdAt: '2026-03-28T00:00:00Z',
          sourceConversationId: 'task-1',
          source: 'initial',
        }}
        nextVersion={{
          id: 'v2',
          title: '新版',
          prompt: 'line-1\nline-2 changed\nline-4',
          model: 'model-b',
          version: 2,
          createdAt: '2026-03-28T01:00:00Z',
          sourceConversationId: 'task-1',
          source: 'regenerate',
        }}
        onKeepOld={onKeepOld}
        onUseNew={onUseNew}
      />
    )

    expect(screen.getByText('旧版')).toBeInTheDocument()
    expect(screen.getByText('新版')).toBeInTheDocument()
    expect(screen.getByText('line-2 changed')).toBeInTheDocument()
    expect(screen.getByText(/\+2 \/ -2 \/ ~1/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('prompt-draft-keep-old-button'))
    fireEvent.click(screen.getByTestId('prompt-draft-use-new-button'))

    expect(onKeepOld).toHaveBeenCalledTimes(1)
    expect(onUseNew).toHaveBeenCalledTimes(1)
  })

  test('disables actions when decision is pending', () => {
    render(
      <PromptDraftComparisonPanel
        previousVersion={{
          id: 'v1',
          title: '旧版',
          prompt: 'a',
          model: 'model-a',
          version: 1,
          createdAt: '2026-03-28T00:00:00Z',
          sourceConversationId: 'task-1',
          source: 'initial',
        }}
        nextVersion={{
          id: 'v2',
          title: '新版',
          prompt: 'b',
          model: 'model-b',
          version: 2,
          createdAt: '2026-03-28T01:00:00Z',
          sourceConversationId: 'task-1',
          source: 'regenerate',
        }}
        onKeepOld={() => {}}
        onUseNew={() => {}}
        isDecisionPending={true}
      />
    )

    expect(screen.getByTestId('prompt-draft-keep-old-button')).toBeDisabled()
    expect(screen.getByTestId('prompt-draft-use-new-button')).toBeDisabled()
  })
})
