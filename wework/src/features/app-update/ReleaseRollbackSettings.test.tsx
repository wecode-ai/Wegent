import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ReleaseRollbackSettings } from './ReleaseRollbackSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), flush: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: mocks.invoke }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))
vi.mock('@/desktop/localStoragePersistence', () => ({
  flushDesktopLocalStoragePersistence: mocks.flush,
}))

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.flush.mockReset().mockResolvedValue(undefined)
})

test.each([false, true])(
  'requires confirmation before rollback; restoreRequired=%s',
  async restoreRequired => {
    mocks.invoke.mockImplementation(async method =>
      method === 'appUpdate.previousRelease' ? { version: '1.0.0', restoreRequired } : {}
    )
    render(<ReleaseRollbackSettings disabled={false} />)
    fireEvent.click(await screen.findByTestId('about-rollback-button'))
    expect(mocks.invoke).not.toHaveBeenCalledWith('appUpdate.rollback', expect.anything())
    fireEvent.click(screen.getByTestId('app-update-rollback-confirm'))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('appUpdate.rollback', {
        restoreConfirmed: restoreRequired,
      })
    )
    expect(mocks.flush).toHaveBeenCalledOnce()
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder.at(-1)!
    )
  }
)

test('reports unavailable rollback metadata', async () => {
  mocks.invoke.mockRejectedValue(new Error('Unavailable'))
  render(<ReleaseRollbackSettings disabled={false} />)
  expect(await screen.findByTestId('about-rollback-error')).toBeVisible()
  expect(screen.queryByTestId('about-rollback-button')).not.toBeInTheDocument()
})
