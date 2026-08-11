// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Restoring a version replaces every page readers currently see, and the pages it
 * overwrites do not keep their document ids — links held to them break. It used to
 * happen on a single click, with only a `title` attribute to warn anyone.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunHistory } from '@/features/knowledge/code-wiki/RunHistory'
import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiRunRecord } from '@/types/code-wiki'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { history: jest.fn(), republish: jest.fn() },
}))

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const RESTORABLE: CodeWikiRunRecord = {
  generation_id: 42,
  status: 'completed',
  mode: 'full',
  started_at: '2026-08-01T00:00:00Z',
  completed_at: '2026-08-01T00:10:00Z',
  commit: 'abcdef1234',
  error_message: '',
  failure_code: '',
  // Not the live one: only then is there anything to go back to.
  published: false,
  task_id: 7,
  task_status: 'COMPLETED',
}

async function openHistory() {
  render(<RunHistory knowledgeBaseId={1} status={null} />)
  fireEvent.click(screen.getByTestId('code-wiki-history-trigger'))
  return screen.findByTestId(`code-wiki-republish-${RESTORABLE.generation_id}`)
}

function mockHistory(runs: CodeWikiRunRecord[]) {
  ;(codeWikiApi.history as jest.Mock).mockResolvedValue({ runs })
}

describe('restoring a past version', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHistory([RESTORABLE])
    ;(codeWikiApi.republish as jest.Mock).mockResolvedValue({})
  })

  it('asks before replacing what readers currently see', async () => {
    const button = await openHistory()

    fireEvent.click(button)

    expect(await screen.findByTestId('code-wiki-republish-confirm')).toBeInTheDocument()
    expect(codeWikiApi.republish).not.toHaveBeenCalled()
  })

  it('restores once confirmed', async () => {
    const button = await openHistory()
    fireEvent.click(button)

    fireEvent.click(await screen.findByTestId(`code-wiki-republish-confirm-${42}`))

    await waitFor(() => expect(codeWikiApi.republish).toHaveBeenCalledWith(1, 42))
  })
})

describe('a failure reason of any length', () => {
  const LONG = 'clone failed: '.repeat(40)
  const FAILED: CodeWikiRunRecord = {
    ...RESTORABLE,
    generation_id: 43,
    status: 'failed',
    error_message: LONG,
    failure_code: '',
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockHistory([FAILED])
  })

  it('is clamped so one bad run cannot crowd out the rest of the history', async () => {
    render(<RunHistory knowledgeBaseId={1} status={null} />)
    fireEvent.click(screen.getByTestId('code-wiki-history-trigger'))

    const reason = await screen.findByTestId('code-wiki-run-error')
    expect(reason.className).toContain('line-clamp-3')
    // Clamped visually, not cut: the text itself is the only diagnostic there is.
    expect(reason).toHaveTextContent('clone failed:')
    expect(reason).toHaveAttribute('title', LONG)
  })

  it('is reachable without a mouse', async () => {
    // It was a <p> with a click handler, which reads the same to a sighted mouse
    // user and leaves a keyboard user unable to open a clamped reason at all.
    render(<RunHistory knowledgeBaseId={1} status={null} />)
    fireEvent.click(screen.getByTestId('code-wiki-history-trigger'))

    const reason = await screen.findByTestId('code-wiki-run-error')
    expect(reason.tagName).toBe('BUTTON')
    expect(reason).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(reason)

    expect(reason).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens up when clicked, because that is what this panel is for', async () => {
    render(<RunHistory knowledgeBaseId={1} status={null} />)
    fireEvent.click(screen.getByTestId('code-wiki-history-trigger'))
    const reason = await screen.findByTestId('code-wiki-run-error')

    fireEvent.click(reason)

    expect(reason.className).not.toContain('line-clamp-3')
  })
})
