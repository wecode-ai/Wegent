import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import '@/i18n'
import {
  RemoteDeviceCommandDetails,
  RemoteDeviceOnboardingNotice,
} from './RemoteDeviceOnboardingDetails'

describe('internal remote device onboarding details', () => {
  test('shows the internal network notice and command metadata', () => {
    render(
      <>
        <RemoteDeviceOnboardingNotice />
        <RemoteDeviceCommandDetails
          command={{
            device_id: 'device-1',
            name: 'remote-device-1',
            image: 'registry.api.weibo.com/ci/wegent-device:1.8.6',
            env: {
              WEGENT_BACKEND_URL: 'https://api.wecode.example.com/api',
              WEGENT_SOCKET_URL: 'wss://socket.wecode.example.com',
            },
            command: 'docker run --network host registry.api.weibo.com/ci/wegent-device:1.8.6',
            commands: [],
          }}
          status="version_mismatch"
        />
      </>
    )

    expect(screen.getByText(/host network/)).toBeInTheDocument()
    expect(screen.getByTestId('remote-docker-image')).toHaveTextContent(
      'registry.api.weibo.com/ci/wegent-device:1.8.6'
    )
    expect(screen.getByTestId('remote-docker-backend-url')).toHaveTextContent(
      'https://api.wecode.example.com/api'
    )
    expect(screen.getByTestId('remote-docker-socket-url')).toHaveTextContent(
      'wss://socket.wecode.example.com'
    )
    expect(screen.getByTestId('remote-docker-connection-status')).toHaveTextContent(
      'Executor 版本需要更新'
    )
  })
})
