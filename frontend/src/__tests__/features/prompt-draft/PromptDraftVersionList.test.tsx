// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'

import { PromptDraftVersionList } from '@/features/prompt-draft/components/PromptDraftVersionList'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('PromptDraftVersionList', () => {
  test('renders version cards and current badge', () => {
    const onRollback = jest.fn()
    const onCompareToCurrent = jest.fn()

    render(
      <PromptDraftVersionList
        versions={[
          {
            id: 'v3',
            title: '新版',
            prompt: 'prompt-v3',
            model: 'm3',
            version: 3,
            createdAt: '2026-03-28T03:00:00Z',
            sourceConversationId: 'task-1',
            source: 'regenerate',
          },
          {
            id: 'v2',
            title: '中间版',
            prompt: 'prompt-v2',
            model: 'm2',
            version: 2,
            createdAt: '2026-03-28T02:00:00Z',
            sourceConversationId: 'task-1',
            source: 'rollback',
          },
          {
            id: 'v1',
            title: '旧版',
            prompt: 'prompt-v1',
            model: 'm1',
            version: 1,
            createdAt: '2026-03-28T01:00:00Z',
            sourceConversationId: 'task-1',
            source: 'initial',
          },
        ]}
        currentVersionId="v3"
        onRollback={onRollback}
        onCompareToCurrent={onCompareToCurrent}
      />
    )

    expect(screen.getByTestId('prompt-draft-version-list')).toBeInTheDocument()
    expect(screen.getByText('新版')).toBeInTheDocument()
    expect(screen.getByText('中间版')).toBeInTheDocument()
    expect(screen.getByText('旧版')).toBeInTheDocument()
    expect(screen.getByText('promptDraft.currentVersion')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('prompt-draft-rollback-button-v2'))
    fireEvent.click(screen.getByTestId('prompt-draft-compare-button-v2'))

    expect(onRollback).toHaveBeenCalledWith('v2')
    expect(onCompareToCurrent).toHaveBeenCalledWith('v2')
  })

  test('disables non-current actions when decision is pending', () => {
    render(
      <PromptDraftVersionList
        versions={[
          {
            id: 'v2',
            title: '新版',
            prompt: 'prompt-v2',
            model: 'm2',
            version: 2,
            createdAt: '2026-03-28T02:00:00Z',
            sourceConversationId: 'task-1',
            source: 'regenerate',
          },
          {
            id: 'v1',
            title: '旧版',
            prompt: 'prompt-v1',
            model: 'm1',
            version: 1,
            createdAt: '2026-03-28T01:00:00Z',
            sourceConversationId: 'task-1',
            source: 'initial',
          },
        ]}
        currentVersionId="v2"
        onRollback={() => {}}
        onCompareToCurrent={() => {}}
        isDecisionPending={true}
      />
    )

    expect(screen.getByTestId('prompt-draft-rollback-button-v1')).toBeDisabled()
    expect(screen.getByTestId('prompt-draft-compare-button-v1')).toBeDisabled()
  })
})
