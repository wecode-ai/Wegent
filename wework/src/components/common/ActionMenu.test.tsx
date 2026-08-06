import { fireEvent, render, screen } from '@testing-library/react'
import { Database, Trash2 } from 'lucide-react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ActionMenu } from './ActionMenu'

function mockMenuBounds() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 48,
    height: 32,
    left: 120,
    right: 240,
    top: 16,
    width: 120,
    x: 120,
    y: 16,
    toJSON: () => ({}),
  })
}

describe('ActionMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockMenuBounds()
  })

  test('opens a first-level submenu and selects its action', async () => {
    const clearCookies = vi.fn()
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Clear browsing data',
            icon: Trash2,
            testId: 'clear-data',
            children: [
              {
                label: 'Clear cookies',
                icon: Database,
                testId: 'clear-cookies',
                onSelect: clearCookies,
              },
            ],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    fireEvent.click(screen.getByTestId('clear-data'))

    const submenu = await screen.findByTestId('clear-data-submenu')
    expect(submenu).toBeVisible()
    fireEvent.click(screen.getByTestId('clear-cookies'))

    expect(clearCookies).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument()
  })

  test('closes the submenu before closing its parent menu on Escape', async () => {
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Clear browsing data',
            icon: Trash2,
            testId: 'clear-data',
            children: [
              {
                label: 'Clear cache',
                icon: Database,
                testId: 'clear-cache',
                onSelect: vi.fn(),
              },
            ],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    fireEvent.click(screen.getByTestId('clear-data'))
    await screen.findByTestId('clear-data-submenu')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('clear-data-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('more-actions-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument()
  })
})
