// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import { useSearchParams } from 'next/navigation'
import OpenWeworkPage from '@/app/open-wework/page'

jest.mock('next/navigation', () => ({ useSearchParams: jest.fn() }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('OpenWeworkPage', () => {
  it('renders a user-initiated desktop link and a web fallback', () => {
    ;(useSearchParams as jest.Mock).mockReturnValue(
      new URLSearchParams('projectId=12&itemId=ISSUE-1&commentId=c-1')
    )

    render(<OpenWeworkPage />)

    expect(screen.getByTestId('open-wework-button')).toHaveAttribute(
      'href',
      'wework://boards/12/issues/ISSUE-1/comments/c-1'
    )
    expect(screen.getByTestId('view-task-button')).toHaveAttribute(
      'href',
      '/collaboration/12/issues/ISSUE-1'
    )
  })

  it('does not render navigation actions for an invalid destination', () => {
    ;(useSearchParams as jest.Mock).mockReturnValue(
      new URLSearchParams('projectId=12&redirect=wework%3A%2F%2Ftasks%2F1%2F2')
    )

    render(<OpenWeworkPage />)

    expect(screen.queryByTestId('open-wework-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('view-task-button')).not.toBeInTheDocument()
    expect(screen.getByText('invalid_title')).toBeInTheDocument()
  })
})
