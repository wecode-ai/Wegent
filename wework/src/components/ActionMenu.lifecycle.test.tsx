import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ActionMenu } from '../../../packages/collaboration/src/controls/ActionMenu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const items = [
  { label: 'Disabled', testId: 'disabled', disabled: true },
  {
    label: 'Parent',
    testId: 'parent',
    shortcut: 'mod+K',
    children: [
      { label: 'Unavailable', testId: 'unavailable', disabled: true, onSelect: vi.fn() },
      { label: 'Child', testId: 'child' },
    ],
  },
  { label: 'Last', testId: 'last' },
]

it('focuses keyboard entry and enabled submenu items, then returns to the parent', async () => {
  const user = userEvent.setup()
  render(<ActionMenu ariaLabel="Actions" testId="trigger" items={items} />)
  await user.tab()
  await user.keyboard('{ArrowUp}')
  await waitFor(() => expect(screen.getByTestId('last')).toHaveFocus())
  await user.keyboard('{ArrowUp}')
  const parent = screen.getByTestId('parent')
  expect(parent).toHaveFocus()
  const shortcuts = parent.querySelectorAll('[data-slot="menu-shortcut"]')
  expect(shortcuts).toHaveLength(1)
  expect(shortcuts[0]).toHaveTextContent(/⌘K|Ctrl\+K/)
  await user.keyboard('{ArrowRight}')
  await waitFor(() => expect(screen.getByTestId('unavailable')).toHaveFocus())
  await user.keyboard('{Enter}')
  expect(items[1].children?.[0].onSelect).not.toHaveBeenCalled()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByTestId('child')).toHaveFocus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByTestId('child')).not.toBeInTheDocument())
  expect(screen.getByTestId('parent')).toHaveFocus()
})

it('keeps clicks inside the submenu open and dismisses outside clicks', async () => {
  const user = userEvent.setup()
  const onOpenChange = vi.fn()
  render(
    <ActionMenu ariaLabel="Actions" testId="trigger" items={items} onOpenChange={onOpenChange} />
  )
  await user.tab()
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(screen.getByTestId('disabled')).toHaveFocus())
  await user.keyboard('{ArrowDown}')
  expect(screen.getByTestId('parent')).toHaveFocus()
  await user.keyboard('{ArrowRight}')
  fireEvent.pointerDown(await screen.findByTestId('parent-submenu'))
  expect(screen.getByTestId('child')).toBeInTheDocument()
  await user.click(document.body)
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
})

it('releases an open submenu and its pending pointer work on unmount', async () => {
  const user = userEvent.setup()
  const onOpenChange = vi.fn()
  const { unmount } = render(
    <ActionMenu ariaLabel="Actions" testId="trigger" items={items} onOpenChange={onOpenChange} />
  )
  await user.tab()
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(screen.getByTestId('disabled')).toHaveFocus())
  await user.keyboard('{ArrowDown}{ArrowRight}')
  const submenu = await screen.findByTestId('parent-submenu')
  vi.useFakeTimers()
  try {
    fireEvent.pointerLeave(submenu, { pointerType: 'mouse' })
    unmount()
    onOpenChange.mockClear()
    await act(async () => vi.runAllTimersAsync())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('restores the previous editor focus when a context menu closes', async () => {
  const editor = document.createElement('input')
  document.body.append(editor)
  editor.focus()
  const onContextMenuClose = vi.fn()
  const { rerender, unmount } = render(
    <ActionMenu
      ariaLabel="Actions"
      testId="trigger"
      items={items}
      contextMenuPosition={{ left: 20, top: 20 }}
      onContextMenuClose={onContextMenuClose}
    />
  )
  try {
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)))
    await waitFor(() =>
      expect(screen.getByRole('menu')).toContainElement(document.activeElement as HTMLElement)
    )
    await userEvent.click(document.body)
    expect(onContextMenuClose).toHaveBeenCalledOnce()
    rerender(<ActionMenu ariaLabel="Actions" testId="trigger" items={items} />)
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(editor).toHaveFocus()
  } finally {
    unmount()
    editor.remove()
  }
})
