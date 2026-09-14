import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ConnectionStatusBanner } from '@/features/tasks/components/input/ConnectionStatusBanner'

const socketState = {
  isConnected: true,
  reconnectAttempts: 0,
}

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => socketState,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('ConnectionStatusBanner', () => {
  afterEach(() => {
    socketState.isConnected = true
    socketState.reconnectAttempts = 0
    jest.useRealTimers()
  })

  it('exposes the connected socket state without rendering a visible banner', () => {
    render(<ConnectionStatusBanner />)

    expect(screen.getByTestId('socket-connection-status')).toHaveAttribute('data-connected', 'true')
    expect(screen.queryByText('status.reconnected')).not.toBeInTheDocument()
  })

  it('exposes the disconnected socket state before the delayed warning appears', () => {
    jest.useFakeTimers()
    socketState.isConnected = false

    render(<ConnectionStatusBanner />)

    expect(screen.getByTestId('socket-connection-status')).toHaveAttribute(
      'data-connected',
      'false'
    )
    expect(screen.queryByText('status.disconnected')).not.toBeInTheDocument()
  })
})
