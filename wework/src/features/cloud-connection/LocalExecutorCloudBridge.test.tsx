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

  test('defers backend changes until runtime tasks are idle', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        backendUrl="https://backend.example.com"
        deferConnectionUpdate
        isConnected
        token="token-a"
      />
    )

    expect(mocks.connect).not.toHaveBeenCalled()

    view.rerender(
      <LocalExecutorCloudBridge
        backendUrl="https://backend.example.com"
        deferConnectionUpdate={false}
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
      <LocalExecutorCloudBridge
        backendUrl="https://next.example.com"
        deferConnectionUpdate
        isConnected
        token="token-b"
      />
    )
    expect(mocks.connect).toHaveBeenCalledTimes(1)

    view.rerender(
      <LocalExecutorCloudBridge
        backendUrl="https://next.example.com"
        deferConnectionUpdate={false}
        isConnected
        token="token-b"
      />
    )
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2))
    expect(mocks.connect).toHaveBeenLastCalledWith({
      backendUrl: 'https://next.example.com',
      authToken: 'token-b',
    })
  })
})
