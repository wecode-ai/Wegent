// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'

describe('long text helpers', () => {
  it('removes native title from a custom tooltip trigger', () => {
    render(
      <LongTextTooltip content="Full tooltip text">
        <button type="button" title="Native tooltip text">
          Trigger
        </button>
      </LongTextTooltip>
    )

    const trigger = screen.getByRole('button', { name: 'Full tooltip text' })
    expect(trigger).not.toHaveAttribute('title')
    expect(trigger).toHaveAttribute('aria-label', 'Full tooltip text')
  })

  it('keeps parent-covered truncated text from creating another tooltip trigger', () => {
    render(<TruncatedText text="Visible text" tooltipText="Full text" focusable={false} />)

    const text = screen.getByText('Visible text')
    expect(text).not.toHaveAttribute('title')
    expect(text).not.toHaveAttribute('tabindex')
    expect(text).toHaveAttribute('aria-label', 'Full text')
  })

  it('uses native title only when explicitly requested', () => {
    render(<TruncatedText text="Visible text" tooltipText="Full text" nativeTitle />)

    expect(screen.getByText('Visible text')).toHaveAttribute('title', 'Full text')
  })
})
