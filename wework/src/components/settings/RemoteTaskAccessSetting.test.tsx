import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteTaskAccessSetting } from './RemoteTaskAccessSetting'

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), t: (key: string) => key }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock('@/desktop/remoteTaskAccess', () => ({
  getRemoteTaskAccess: mocks.get,
  setRemoteTaskAccess: mocks.set,
}))

describe('RemoteTaskAccessSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t = (key: string) => key
    mocks.get.mockResolvedValue({ enabled: false })
    mocks.set.mockImplementation(async enabled => ({ enabled }))
  })

  it('starts disabled and saves only the local switch without a target device or cloud write', async () => {
    render(<RemoteTaskAccessSetting />)
    const toggle = screen.getByTestId('remote-task-access-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith(true)
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(mocks.set).toHaveBeenLastCalledWith(false)
  })

  it('retains the persisted state on failure and allows recovery', async () => {
    mocks.get.mockResolvedValue({ enabled: true })
    mocks.set.mockRejectedValueOnce(new Error('disk full'))
    render(<RemoteTaskAccessSetting />)
    const toggle = screen.getByTestId('remote-task-access-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('remote_task_access_save_failed')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the switch disabled when local settings cannot be loaded', async () => {
    mocks.get.mockRejectedValue(new Error('unavailable'))
    render(<RemoteTaskAccessSetting />)
    expect(await screen.findByRole('alert')).toHaveTextContent('remote_task_access_load_failed')
    expect(screen.getByTestId('remote-task-access-toggle')).toBeDisabled()
  })

  it('retries a failed local read without leaving the settings page', async () => {
    mocks.get.mockRejectedValueOnce(new Error('unavailable'))
    render(<RemoteTaskAccessSetting />)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByTestId('remote-task-access-retry'))
    const toggle = screen.getByTestId('remote-task-access-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.set).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('finishes a pending save when the interface language changes', async () => {
    let completeSave!: (settings: { enabled: boolean }) => void
    mocks.set.mockReturnValue(
      new Promise(resolve => {
        completeSave = resolve
      })
    )
    const { rerender } = render(<RemoteTaskAccessSetting />)
    const toggle = screen.getByTestId('remote-task-access-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    mocks.t = (key: string) => `translated:${key}`
    rerender(<RemoteTaskAccessSetting />)
    await act(async () => completeSave({ enabled: true }))
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it('ignores focus refresh during a local save and rejects stale refresh responses', async () => {
    let completeSave!: (settings: { enabled: boolean }) => void
    mocks.set.mockReturnValue(
      new Promise(resolve => {
        completeSave = resolve
      })
    )
    render(<RemoteTaskAccessSetting />)
    const toggle = screen.getByTestId('remote-task-access-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(mocks.get).toHaveBeenCalledTimes(1)
    await act(async () => completeSave({ enabled: true }))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    let completeOldRead!: (settings: { enabled: boolean }) => void
    mocks.get.mockReturnValueOnce(
      new Promise(resolve => {
        completeOldRead = resolve
      })
    )
    act(() => window.dispatchEvent(new Event('focus')))
    mocks.get.mockResolvedValueOnce({ enabled: true })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(toggle).toBeEnabled())
    await act(async () => completeOldRead({ enabled: false }))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})
