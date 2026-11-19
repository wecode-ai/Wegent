import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    children: [
      { label: 'Unavailable', testId: 'unavailable', disabled: true },
      { label: 'Child', testId: 'child' },
    ],
  },
  { label: 'Last', testId: 'last' },
]

it('focuses keyboard entry and enabled submenu items, then returns to the parent', async () => {
  render(<ActionMenu ariaLabel="Actions" testId="trigger" items={items} />)
  fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'ArrowUp' })
  await act(async () => new Promise(resolve => requestAnimationFrame(resolve)))
  expect(screen.getByTestId('last')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('parent'), { key: 'ArrowRight' })
  expect(screen.getByTestId('child')).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('child')).not.toBeInTheDocument()
  expect(screen.getByTestId('parent')).toHaveFocus()
})

it('keeps clicks inside the submenu open and dismisses outside clicks', () => {
  const onOpenChange = vi.fn()
  render(
    <ActionMenu ariaLabel="Actions" testId="trigger" items={items} onOpenChange={onOpenChange} />
  )
  fireEvent.click(screen.getByTestId('trigger'))
  fireEvent.keyDown(screen.getByTestId('parent'), { key: 'ArrowRight' })
  fireEvent.pointerDown(screen.getByTestId('parent-submenu'))
  expect(screen.getByTestId('child')).toBeInTheDocument()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
})

it('cancels pending focus and submenu close work when its menu unmounts', () => {
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const clear = vi.spyOn(window, 'clearTimeout')
  const { unmount } = render(<ActionMenu ariaLabel="Actions" testId="trigger" items={items} />)
  fireEvent.click(screen.getByTestId('trigger'))
  fireEvent.keyDown(screen.getByTestId('parent'), { key: 'ArrowRight' })
  fireEvent.pointerLeave(screen.getByTestId('parent-submenu'))
  unmount()
  expect(cancel).toHaveBeenCalled()
  expect(clear).toHaveBeenCalled()
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
    expect(screen.getByRole('menu')).toHaveFocus()
    fireEvent.pointerDown(document.body)
    expect(onContextMenuClose).toHaveBeenCalledOnce()
    rerender(<ActionMenu ariaLabel="Actions" testId="trigger" items={items} />)
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(editor).toHaveFocus()
  } finally {
    unmount()
    editor.remove()
  }
})
