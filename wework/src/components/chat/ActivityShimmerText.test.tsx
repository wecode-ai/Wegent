import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ActivityShimmerText } from './ActivityShimmerText'

describe('ActivityShimmerText', () => {
  it('renders one bounded highlight band per grapheme without copying the full text', () => {
    const text = 'W'.repeat(120)
    const { container } = render(<ActivityShimmerText variant="tool">{text}</ActivityShimmerText>)

    const bands = container.querySelectorAll('.activity-shimmer-band')

    expect(bands).toHaveLength(96)
    expect(bands[0]).toHaveAttribute('data-grapheme', 'W')
    expect(container.querySelector('[data-text]')).not.toBeInTheDocument()
  })

  it('keeps proportional graphemes in independent inline bands', () => {
    const { container } = render(<ActivityShimmerText variant="thinking">Wi</ActivityShimmerText>)

    expect(
      Array.from(container.querySelectorAll('.activity-shimmer-band'), band =>
        band.getAttribute('data-grapheme')
      )
    ).toEqual(['W', 'i'])
  })
})
