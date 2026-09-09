import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ActivityShimmerText } from './ActivityShimmerText'

describe('ActivityShimmerText', () => {
  it('uses a fixed number of composited layers regardless of text length', () => {
    const text = 'W'.repeat(120)
    const { container } = render(<ActivityShimmerText variant="tool">{text}</ActivityShimmerText>)

    expect(container.querySelectorAll('.activity-shimmer-sweep')).toHaveLength(1)
    expect(container.querySelectorAll('.activity-shimmer-band')).toHaveLength(1)
    expect(container.querySelector('.activity-shimmer-band')).toHaveAttribute('data-text', text)
    expect(container.querySelector('[data-grapheme]')).not.toBeInTheDocument()
  })

  it('keeps the accessible base text separate from the visual highlight copy', () => {
    const { container } = render(<ActivityShimmerText variant="thinking">Wi</ActivityShimmerText>)

    const shimmer = container.querySelector('.activity-shimmer-text')
    const highlight = container.querySelector('.activity-shimmer-highlight')

    expect(shimmer).toHaveTextContent('Wi')
    expect(highlight).toHaveAttribute('aria-hidden', 'true')
    expect(highlight).not.toHaveTextContent('Wi')
    expect(highlight?.querySelector('.activity-shimmer-band')).toHaveAttribute('data-text', 'Wi')
  })
})
