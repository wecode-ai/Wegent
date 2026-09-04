// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import {
  GenerationProgress,
  visibleProgress,
} from '@/features/knowledge/code-wiki/GenerationProgress'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function status(over: Partial<CodeWikiRunStatus> = {}): CodeWikiRunStatus {
  return {
    status: 'running',
    generation_id: 34,
    error_message: '',
    failure_code: '',
    is_stale: false,
    last_published_commit: '',
    progress: {
      stage: 'writing',
      current_step: 2,
      total_steps: 3,
      pages_written: 7,
      pages_total: 13,
    },
    ...over,
  }
}

describe('code wiki generation progress', () => {
  it('shows the three plan-only stages with completed, active, and pending states', () => {
    render(<GenerationProgress status={status()} />)

    expect(screen.getByTestId('code-wiki-progress-stage')).toHaveTextContent(
      'codeWiki.progress.stage.writing'
    )
    expect(screen.getByTestId('code-wiki-progress-plan')).toHaveTextContent(
      'codeWiki.progress.stepLabel.planPassed'
    )
    expect(screen.getByTestId('code-wiki-progress-writing')).toHaveTextContent(
      'codeWiki.progress.stepLabel.writingActive'
    )
    expect(screen.queryByTestId('code-wiki-progress-qa')).not.toBeInTheDocument()
    expect(screen.getByTestId('code-wiki-progress-publish')).toHaveTextContent(
      'codeWiki.progress.stepLabel.publish'
    )
    expect(screen.getByTestId('code-wiki-progress-step')).toHaveTextContent(
      'codeWiki.progress.step'
    )
  })

  it('keeps the reserved QA stage for a four-stage run', () => {
    render(
      <GenerationProgress
        status={status({
          progress: {
            stage: 'qa_review',
            current_step: 3,
            total_steps: 4,
            pages_written: 13,
            pages_total: 13,
          },
        })}
      />
    )

    expect(screen.getByTestId('code-wiki-progress-qa')).toHaveTextContent(
      'codeWiki.progress.stage.qa_review'
    )
  })

  it('expands by default and can be collapsed and reopened', () => {
    render(<GenerationProgress status={status()} />)

    const toggle = screen.getByTestId('code-wiki-progress-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('code-wiki-progress-steps')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByTestId('code-wiki-progress-steps')).toBeInTheDocument()
  })

  it('shows a generic run without inventing a numbered workflow', () => {
    render(
      <GenerationProgress
        status={status({
          progress: {
            stage: 'generating',
            current_step: 0,
            total_steps: 0,
            pages_written: 0,
            pages_total: 0,
          },
        })}
      />
    )

    expect(screen.getByTestId('code-wiki-generation-progress')).toBeInTheDocument()
    expect(screen.queryByTestId('code-wiki-progress-step')).not.toBeInTheDocument()
  })

  it('hides progress after completion or when the worker is stale', () => {
    expect(visibleProgress(status({ status: 'completed' }))).toBeNull()
    expect(visibleProgress(status({ is_stale: true }))).toBeNull()
  })

  it('offers an enabled manager a stop action without toggling the stages', () => {
    const onCancel = jest.fn()
    render(<GenerationProgress status={status()} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('code-wiki-progress-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('code-wiki-progress-steps')).toBeInTheDocument()
  })
})
