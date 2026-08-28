import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SmartAppsSectionNav } from './SmartAppsSectionNav'

const mocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  updateActiveTab: vi.fn(),
  workspaceTabs: null as { updateActiveTab: (updates: { contentRoute: string }) => void } | null,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: (path: string) => mocks.navigateTo(path),
}))

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useOptionalWorkspaceTabs: () => mocks.workspaceTabs,
}))

describe('SmartAppsSectionNav', () => {
  beforeEach(() => {
    mocks.navigateTo.mockReset()
    mocks.updateActiveTab.mockReset()
    mocks.workspaceTabs = null
  })

  test('updates the active workspace tab when opening My apps', () => {
    mocks.workspaceTabs = { updateActiveTab: mocks.updateActiveTab }
    render(<SmartAppsSectionNav active="marketplace" />)

    expect(screen.getByTestId('smart-apps-section-marketplace')).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByTestId('smart-apps-section-owned'))

    expect(mocks.updateActiveTab).toHaveBeenCalledWith({
      contentRoute: '/sites?app_type=smart_app&view=owned',
    })
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  test('falls back to standalone navigation outside workspace tabs', () => {
    render(<SmartAppsSectionNav active="owned" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByTestId('smart-apps-section-marketplace'))

    expect(mocks.navigateTo).toHaveBeenCalledWith('/sites?app_type=smart_app')
    expect(mocks.updateActiveTab).not.toHaveBeenCalled()
  })

  test('exposes exactly Marketplace and My as peer sections', () => {
    render(<SmartAppsSectionNav active="marketplace" />)

    expect(screen.getByTestId('smart-apps-section-owned')).toHaveTextContent('我的')
    expect(screen.queryByText('已安装')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByTestId('smart-apps-section-nav')).toHaveClass('md:h-9', 'md:w-[168px]')
  })
})
