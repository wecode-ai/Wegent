import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PluginManagementSectionNav } from './PluginManagementSectionNav'

const navigateTo = vi.fn()

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: (path: string) => navigateTo(path),
}))

describe('PluginManagementSectionNav', () => {
  beforeEach(() => {
    navigateTo.mockReset()
  })

  test('opens Harness management from the plugin management section', () => {
    render(<PluginManagementSectionNav active="plugins" />)

    expect(screen.getByTestId('plugin-management-section-plugins')).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByTestId('plugin-management-section-harness'))

    expect(navigateTo).toHaveBeenCalledWith('/plugins/manage/harness')
  })

  test('returns to installed plugins from Harness management', () => {
    render(<PluginManagementSectionNav active="harness" />)

    expect(screen.getByTestId('plugin-management-section-harness')).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByTestId('plugin-management-section-plugins'))

    expect(navigateTo).toHaveBeenCalledWith('/plugins/manage')
  })
})
