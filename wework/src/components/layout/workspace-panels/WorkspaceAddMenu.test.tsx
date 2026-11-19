import { act, fireEvent, render, screen } from '@testing-library/react'
import { Plus } from 'lucide-react'
import { expect, test, vi } from 'vitest'
import { setEmbeddedBrowserOcclusion } from '@/lib/embedded-browser'
import { track } from '@/telemetry/client'
import { WorkspaceAddMenu } from './WorkspaceAddMenu'

vi.mock('@/lib/embedded-browser', () => ({ setEmbeddedBrowserOcclusion: vi.fn() }))
vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))

const props = {
  ariaLabel: 'Add panel',
  buttonTestId: 'add-panel',
  menuTestId: 'panels',
  buttonClassName: '',
}

test('owns browser occlusion only while mounted and respects IME Escape and inside pointer events', () => {
  const { unmount } = render(
    <WorkspaceAddMenu
      {...props}
      items={[{ id: 'files', label: 'Files', icon: Plus, onSelect: vi.fn() }]}
    />
  )
  fireEvent.click(screen.getByTestId('add-panel'))
  expect(setEmbeddedBrowserOcclusion).toHaveBeenLastCalledWith('workspace-add-menu', true)
  fireEvent.pointerDown(screen.getByRole('menuitem'))
  expect(screen.getByTestId('panels')).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
  expect(screen.getByTestId('panels')).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('panels')).toBeNull()
  expect(setEmbeddedBrowserOcclusion).toHaveBeenLastCalledWith('workspace-add-menu', false)
  fireEvent.click(screen.getByTestId('add-panel'))
  unmount()
  expect(setEmbeddedBrowserOcclusion).toHaveBeenLastCalledWith('workspace-add-menu', false)
})

test('closes on an outside pointer and never selects a disabled item', () => {
  const select = vi.fn()
  render(
    <WorkspaceAddMenu
      {...props}
      items={[{ id: 'files', label: 'Files', icon: Plus, onSelect: select, disabled: true }]}
    />
  )
  fireEvent.click(screen.getByTestId('add-panel'))
  fireEvent.click(screen.getByRole('menuitem'))
  expect(select).not.toHaveBeenCalled()
  expect(screen.getByTestId('panels')).toBeInTheDocument()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByTestId('panels')).toBeNull()
  expect(setEmbeddedBrowserOcclusion).toHaveBeenLastCalledWith('workspace-add-menu', false)
})

test('removes occlusion before an asynchronous panel action finishes', async () => {
  let finish!: () => void
  const select = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  render(
    <WorkspaceAddMenu
      {...props}
      items={[{ id: 'files', label: 'Files', icon: Plus, onSelect: select }]}
    />
  )
  fireEvent.click(screen.getByTestId('add-panel'))
  fireEvent.click(screen.getByRole('menuitem'))
  expect(screen.queryByTestId('panels')).toBeNull()
  expect(setEmbeddedBrowserOcclusion).toHaveBeenLastCalledWith('workspace-add-menu', false)
  expect(select).toHaveBeenCalledOnce()
  await act(async () => finish())
  expect(track).toHaveBeenLastCalledWith('workspace_panel_added', { panel: 'files' })
})
