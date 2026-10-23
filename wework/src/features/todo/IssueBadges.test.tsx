import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
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

  it('renders a PR-looking URL unchanged and only opens it on an explicit click', () => {
    const url = 'https://github.com/org/app/pull/42'
    render(
      <IssueBadges
        badges={[
          {
            id: 'arbitrary',
            label: 'Build result',
            url,
            icon: 'link',
            tone: 'warning',
            tooltip: 'Producer-owned status',
          },
        ]}
        compact
      />
    )
    const badge = screen.getByTestId('issue-badge-arbitrary')
    expect(badge).toHaveAccessibleName('Build result · Producer-owned status')
    expect(badge).toHaveClass('text-amber-600')
    expect(badge).not.toHaveTextContent('#42')
    fireEvent.click(badge)
    expect(openExternalUrl).toHaveBeenCalledWith(url)
  })

  it('does not render empty badge collections', () => {
    render(<IssueBadges badges={[]} />)
    expect(screen.queryByTestId('issue-badges')).not.toBeInTheDocument()
  })
})
