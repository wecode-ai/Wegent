import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SmartAppsSectionNav } from './SmartAppsSectionNav'

const navigateTo = vi.fn()

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: (path: string) => navigateTo(path),
}))

describe('SmartAppsSectionNav', () => {
  beforeEach(() => {
    navigateTo.mockReset()
  })

  test('opens My apps from the marketplace', () => {
    render(<SmartAppsSectionNav active="marketplace" />)

    expect(screen.getByTestId('smart-apps-section-marketplace')).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByTestId('smart-apps-section-owned'))

    expect(navigateTo).toHaveBeenCalledWith('/sites?app_type=smart_app&view=owned')
  })

  test('returns to the Smart app marketplace', () => {
    render(<SmartAppsSectionNav active="owned" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByTestId('smart-apps-section-marketplace'))

    expect(navigateTo).toHaveBeenCalledWith('/sites?app_type=smart_app')
  })

  test('exposes exactly Marketplace and My as peer sections', () => {
    render(<SmartAppsSectionNav active="marketplace" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveTextContent('我的')
    expect(screen.queryByText('已安装')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
