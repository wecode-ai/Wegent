import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Database, Trash2 } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

  afterEach(() => {
    vi.useRealTimers()
  })

  test('mouse opening does not focus an action or return focus to the icon after Escape', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ActionMenu
        ariaLabel="Project actions"
        testId="project-actions"
        items={[{ label: 'Archive all', testId: 'archive', onSelect }]}
      />
    )
    const trigger = screen.getByTestId('project-actions')
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('menu')).toHaveFocus())
    expect(screen.getByTestId('archive')).not.toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).not.toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  test.each(['{Enter}', ' ', '{ArrowDown}', '{ArrowUp}'])(
    'keyboard opening with %s focuses enabled checkbox items and restores the trigger',
    async key => {
      const user = userEvent.setup()
      render(
        <ActionMenu
          ariaLabel="Project actions"
          testId="project-actions"
          items={[
            { label: 'Archive all', testId: 'archive', disabled: true, onSelect: vi.fn() },
            { label: 'Show offline', testId: 'offline', checked: true, onSelect: vi.fn() },
            { label: 'Settings', testId: 'settings', onSelect: vi.fn() },
          ]}
        />
      )
      const trigger = screen.getByTestId('project-actions')
      trigger.focus()
      await user.keyboard(key)
      await waitFor(() =>
        expect(screen.getByTestId(key === '{ArrowUp}' ? 'settings' : 'offline')).toHaveFocus()
      )
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      await waitFor(() => expect(trigger).toHaveFocus())
    }
  )

  test('supports arrow navigation and selection after opening with the mouse', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ActionMenu
        ariaLabel="Project actions"
        testId="project-actions"
        items={[
          { label: 'Archive all', testId: 'archive', disabled: true, onSelect: vi.fn() },
          { label: 'Show offline', testId: 'offline', checked: true, onSelect },
        ]}
      />
    )
    await user.click(screen.getByTestId('project-actions'))
    await waitFor(() => expect(screen.getByRole('menu')).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('offline')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  test('shows the shared tooltip for an icon-only trigger', () => {
    vi.useFakeTimers()
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Delete',
            testId: 'delete',
            onSelect: vi.fn(),
          },
        ]}
      />
    )

    const trigger = screen.getByTestId('more-actions')
    expect(trigger).not.toHaveAttribute('title')

    fireEvent.pointerEnter(trigger.parentElement as HTMLElement)
    act(() => vi.advanceTimersByTime(700))

    expect(screen.getByTestId('more-actions-tooltip')).toHaveTextContent('More actions')
  })

  test('does not add a layout wrapper when the trigger tooltip is disabled', () => {
    render(
      <ActionMenu
        ariaLabel="Context actions"
        testId="context-actions"
        triggerClassName="hidden"
        showTriggerTooltip={false}
        items={[]}
      />
    )

    const trigger = screen.getByTestId('context-actions')
    expect(trigger).toHaveClass('hidden')
    expect(trigger.parentElement?.children).toHaveLength(1)
    expect(trigger.parentElement?.firstElementChild).toBe(trigger)
    expect(screen.queryByTestId('context-actions-tooltip')).not.toBeInTheDocument()
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

  test('opens submenu on hover, closes on mouse leave, and reopens on re-hover', async () => {
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Clear browsing data',
            testId: 'clear-data',
            children: [
              {
                label: 'Clear cookies',
                testId: 'clear-cookies',
                onSelect: vi.fn(),
              },
            ],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    expect(screen.queryByTestId('clear-data-submenu')).not.toBeInTheDocument()

    fireEvent.pointerEnter(screen.getByTestId('clear-data'))
    await screen.findByTestId('clear-data-submenu')

    fireEvent.pointerLeave(screen.getByTestId('clear-data'))
    await waitFor(() => {
      expect(screen.queryByTestId('clear-data-submenu')).not.toBeInTheDocument()
    })

    fireEvent.pointerEnter(screen.getByTestId('clear-data'))
    await screen.findByTestId('clear-data-submenu')
  })

  test('keeps a zero-delay submenu selectable across the pointer gap', async () => {
    const openInVsCode = vi.fn()
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        submenuCloseDelayMs={0}
        items={[
          {
            label: 'Open with',
            testId: 'open-with',
            children: [{ label: 'VS Code', testId: 'vscode', onSelect: openInVsCode }],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    fireEvent.pointerEnter(screen.getByTestId('open-with'))
    await screen.findByTestId('open-with-submenu')
    fireEvent.pointerLeave(screen.getByTestId('open-with'))
    fireEvent.pointerEnter(screen.getByTestId('open-with-submenu'))
    fireEvent.click(screen.getByTestId('vscode'))

    expect(openInVsCode).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('open-with-submenu')).not.toBeInTheDocument()
  })

  test('closes when an outside target stops pointer event propagation', async () => {
    render(
      <>
        <ActionMenu
          ariaLabel="More actions"
          testId="more-actions"
          items={[{ label: 'Settings', testId: 'settings-item', onSelect: vi.fn() }]}
        />
        <div data-testid="editor-surface" onPointerDown={event => event.stopPropagation()} />
      </>
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    expect(screen.getByTestId('more-actions-menu')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('editor-surface'))

    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument()
  })

  test('toggles submenu open and closed when clicking a parent item', async () => {
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Clear browsing data',
            testId: 'clear-data',
            children: [
              {
                label: 'Clear cookies',
                testId: 'clear-cookies',
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

    fireEvent.click(screen.getByTestId('clear-data'))
    await waitFor(() => {
      expect(screen.queryByTestId('clear-data-submenu')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('clear-data'))
    await screen.findByTestId('clear-data-submenu')
  })

  test('renders separator and custom rows without making them menu items', () => {
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Zoom',
            testId: 'zoom-row',
            custom: <span data-testid="zoom-row-content">100%</span>,
          },
          { label: '', testId: 'menu-separator', separator: true },
          { label: 'Settings', testId: 'settings-item', onSelect: vi.fn() },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))

    expect(screen.getByTestId('zoom-row-content')).toBeInTheDocument()
    expect(screen.getByTestId('zoom-row')).not.toHaveAttribute('role', 'menuitem')
    expect(screen.getByTestId('menu-separator')).toHaveAttribute('role', 'separator')
    expect(screen.getByTestId('settings-item')).toHaveAttribute('role', 'menuitem')
  })

  test('keeps the menu open when interacting with a custom row', () => {
    const zoomIn = vi.fn()
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Zoom',
            testId: 'zoom-row',
            custom: (
              <button type="button" data-testid="zoom-in-control" onClick={zoomIn}>
                Zoom in
              </button>
            ),
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))
    fireEvent.click(screen.getByTestId('zoom-in-control'))

    expect(zoomIn).toHaveBeenCalledOnce()
    expect(screen.getByTestId('more-actions-menu')).toBeInTheDocument()
  })

  test('exposes checked items with checkbox menu semantics', () => {
    render(
      <ActionMenu
        ariaLabel="More actions"
        testId="more-actions"
        items={[
          {
            label: 'Show offline devices',
            testId: 'show-offline-devices',
            checked: true,
            onSelect: vi.fn(),
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('more-actions'))

    const item = screen.getByTestId('show-offline-devices')
    expect(item).toHaveAttribute('role', 'menuitemcheckbox')
    expect(item).toHaveAttribute('aria-checked', 'true')
    expect(item.querySelector('svg')).toBeInTheDocument()
  })
})
