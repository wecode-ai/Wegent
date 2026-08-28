import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DshIcon } from './DshIcon'

describe('DshIcon', () => {
  it('loads any valid Lucide icon name dynamically', async () => {
    render(<DshIcon name="shield" data-testid="dsh-icon" />)

    await waitFor(() => {
      expect(screen.getByTestId('dsh-icon')).toHaveClass('lucide-shield')
    })
  })

  it('keeps legacy aliases and falls back for unknown names', () => {
    const { rerender } = render(<DshIcon name="applications" data-testid="dsh-icon" />)
    expect(screen.getByTestId('dsh-icon')).toHaveClass('lucide-grid3x3')

    rerender(<DshIcon name="not-a-real-icon" data-testid="dsh-icon" />)
    expect(screen.getByTestId('dsh-icon')).toHaveClass('lucide-grid3x3')
  })
})
