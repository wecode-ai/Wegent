import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { remoteDeviceOnboardingExtension } from './remote-device-onboarding'

describe('remote device onboarding fallback extension', () => {
  test('does not render internal remote device details', () => {
    const Notice = remoteDeviceOnboardingExtension.Notice
    const noticeView = render(<Notice />)
    const CommandDetails = remoteDeviceOnboardingExtension.CommandDetails
    const detailsView = render(
      <CommandDetails
        command={{
          device_id: 'device-1',
          name: 'remote-device-1',
          image: 'ghcr.io/wecode-ai/wegent-device:latest',
          env: {},
          command: 'docker run ghcr.io/wecode-ai/wegent-device:latest',
          commands: [],
        }}
        status="waiting"
      />
    )

    expect(noticeView.container).toBeEmptyDOMElement()
    expect(detailsView.container).toBeEmptyDOMElement()
  })
})
