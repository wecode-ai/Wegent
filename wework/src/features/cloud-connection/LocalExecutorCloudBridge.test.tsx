import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudBridge'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnect: vi.fn().mockResolvedValue({ running: true, ready: true }),
}))

vi.mock('./cloudConnectionAvailability', () => ({
  isCloudConnectionUiAvailable: () => true,
}))

vi.mock('@/tauri/localExecutor', () => ({
  connectLocalExecutorToBackend: mocks.connect,
  disconnectLocalExecutorFromBackend: mocks.disconnect,
}))

describe('LocalExecutorCloudBridge', () => {
  beforeEach(() => {
    mocks.connect.mockClear()
    mocks.disconnect.mockClear()
  })

  test('updates backend connection whenever the cloud target changes', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        backendUrl="https://backend.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        authToken: 'token-a',
      })
    })

    view.rerender(
      <LocalExecutorCloudBridge backendUrl="https://next.example.com" isConnected token="token-b" />
    )
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2))
    expect(mocks.connect).toHaveBeenLastCalledWith({
      backendUrl: 'https://next.example.com',
      authToken: 'token-b',
    })
  })

  test('disconnects the executor when the cloud connection is unavailable', async () => {
    render(<LocalExecutorCloudBridge isConnected={false} token={null} />)

    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledTimes(1))
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
