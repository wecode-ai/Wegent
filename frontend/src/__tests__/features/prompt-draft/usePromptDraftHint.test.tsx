// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from '@testing-library/react'

import { usePromptDraftHint } from '@/features/prompt-draft/hooks/usePromptDraftHint'

function PromptDraftHintHarness({ taskId }: { taskId: number | null }) {
  const visible = usePromptDraftHint(taskId)
  return <div>{visible ? 'shown' : 'hidden'}</div>
}

describe('usePromptDraftHint', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.restoreAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  test('shows then hides the hint when cooldown has expired', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.1)

    render(<PromptDraftHintHarness taskId={1} />)

    expect(screen.getByText('hidden')).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    expect(screen.getByText('shown')).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(6000)
    })

    expect(screen.getByText('hidden')).toBeInTheDocument()
  })

  test('skips showing the hint during cooldown', () => {
    localStorage.setItem('pet-prompt-hint-last', String(Date.now()))
    jest.spyOn(Math, 'random').mockReturnValue(0.1)

    render(<PromptDraftHintHarness taskId={1} />)

    act(() => {
      jest.advanceTimersByTime(8000)
    })

    expect(screen.getByText('hidden')).toBeInTheDocument()
  })
})
