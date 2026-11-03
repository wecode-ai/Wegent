import '@/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IssueBadges } from './IssueBadges'

const openExternalUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))

describe('generic IssueBadges', () => {
  it('renders supplied icon, tone and tooltip without a device or business adapter', () => {
    render(
      <IssueBadges
        badges={[
          {
            id: 'review',
            label: 'Reviewed',
            tone: 'success',
            icon: 'check',
            tooltip: 'Approved by reviewer',
          },
        ]}
        compact
      />
    )
    expect(screen.getByText('Reviewed')).toBeVisible()
    expect(screen.getByTitle('Approved by reviewer')).toHaveClass('text-green-600')
  })
})
