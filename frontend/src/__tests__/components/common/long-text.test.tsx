// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

  it('shows the tooltip content on hover through the real Radix path', async () => {
    const user = userEvent.setup()
    render(
      <LongTextTooltip content="Full tooltip text">
        <button type="button">Trigger</button>
      </LongTextTooltip>
    )

    await user.hover(screen.getByRole('button', { name: 'Full tooltip text' }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Full tooltip text')
  })

  it('truncates with a hover tooltip and no tab stop when not focusable', async () => {
    const user = userEvent.setup()
    render(<TruncatedText text="Visible text" tooltipText="Full text" focusable={false} />)

    const text = screen.getByText('Visible text')
    expect(text).not.toHaveAttribute('title')
    expect(text).not.toHaveAttribute('tabindex')
    expect(text).toHaveAttribute('aria-label', 'Full text')

    await user.hover(text)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Full text')
  })

  it('shows the tooltip content on keyboard focus when focusable', async () => {
    const user = userEvent.setup()
    render(<TruncatedText text="Visible text" />)

    const text = screen.getByText('Visible text')
    expect(text).toHaveAttribute('tabindex', '0')
    expect(text).toHaveAttribute('aria-label', 'Visible text')

    await user.tab()
    expect(text).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Visible text')
  })
})
