import { render, screen } from '@testing-library/react'
import { Loader2 } from 'lucide-react'
import { describe, expect, test } from 'vitest'
import { CompositedSpinner } from './CompositedSpinner'

describe('CompositedSpinner', () => {
  test('rotates an HTML compositing layer without animating the SVG', () => {
    render(
      <CompositedSpinner data-testid="spinner" icon={Loader2} className="h-4 w-4 text-primary" />
    )

    const spinner = screen.getByTestId('spinner')
    expect(spinner).toBeInstanceOf(HTMLSpanElement)
    expect(spinner).toHaveClass('animate-spin', 'will-change-transform')
    expect(spinner.querySelector('svg')).not.toHaveClass('animate-spin')
  })

  test('preserves caller size overrides after moving into the shared package', () => {
    render(<CompositedSpinner data-testid="spinner" iconClassName="h-3 w-3" />)
    const icon = screen.getByTestId('spinner').querySelector('svg')
    expect(icon).toHaveClass('h-3', 'w-3')
    expect(icon).not.toHaveClass('h-full', 'w-full')
  })
})
