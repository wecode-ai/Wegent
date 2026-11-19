import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  listLocalWorkspaceOpeners,
  type LocalWorkspaceOpenerAvailability,
} from '@/lib/local-terminal'
import { useLocalWorkspaceOpeners } from './useLocalWorkspaceOpeners'

vi.mock('@/lib/local-terminal', () => ({ listLocalWorkspaceOpeners: vi.fn() }))

function Probe({ active, id }: { active: boolean; id: string }) {
  const catalog = useLocalWorkspaceOpeners(active)
  return (
    <div>
      <span data-testid={id} data-status={catalog.status}>
        {catalog.status === 'error'
          ? String(catalog.error)
          : catalog.data?.map(item => item.label).join(',')}
      </span>
      <button data-testid={id + '-refresh'} onClick={() => void catalog.refresh()}>
        Refresh
      </button>
    </div>
  )
}
const editors: LocalWorkspaceOpenerAvailability[] = [
  { id: 'vscode', available: true, label: 'VS Code', category: 'general' },
]

test('shares a pending native catalog between active views and publishes explicit refreshes to both', async () => {
  let finish!: (value: LocalWorkspaceOpenerAvailability[]) => void
  const load = vi
    .mocked(listLocalWorkspaceOpeners)
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce([{ ...editors[0], label: 'Updated Code' }])
  const { rerender, unmount } = render(
    <>
      <Probe id="first" active={false} />
      <Probe id="second" active={false} />
    </>
  )
  expect(load).not.toHaveBeenCalled()
  rerender(
    <>
      <Probe id="first" active />
      <Probe id="second" active />
    </>
  )
  expect(load).toHaveBeenCalledOnce()
  await act(async () => finish(editors))
  expect(screen.getByTestId('first')).toHaveTextContent('VS Code')
  expect(screen.getByTestId('second')).toHaveTextContent('VS Code')
  fireEvent.click(screen.getByTestId('first-refresh'))
  await waitFor(() => expect(screen.getByTestId('second')).toHaveTextContent('Updated Code'))
  expect(load).toHaveBeenCalledTimes(2)
  unmount()
})

test('isolates native catalog failures and recovers on an explicit refresh', async () => {
  const load = vi
    .mocked(listLocalWorkspaceOpeners)
    .mockReset()
    .mockRejectedValueOnce(new Error('Native catalog unavailable'))
    .mockResolvedValueOnce(editors)
  const { unmount } = render(<Probe id="catalog" active />)
  await waitFor(() =>
    expect(screen.getByTestId('catalog')).toHaveTextContent('Native catalog unavailable')
  )
  fireEvent.click(screen.getByTestId('catalog-refresh'))
  await waitFor(() => expect(screen.getByTestId('catalog')).toHaveTextContent('VS Code'))
  expect(screen.getByTestId('catalog')).toHaveAttribute('data-status', 'ready')
  expect(load).toHaveBeenCalledTimes(2)
  unmount()
})
