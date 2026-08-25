// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import VideoSettingsPopover from '@/features/tasks/components/selector/VideoSettingsPopover'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('VideoSettingsPopover', () => {
  it('keeps ratio and resolution controls while hiding duration', () => {
    const onRatioChange = jest.fn()
    const onResolutionChange = jest.fn()

    render(
      <VideoSettingsPopover
        selectedRatio="16:9"
        onRatioChange={onRatioChange}
        availableRatios={['16:9', '9:16']}
        selectedDuration={5}
        onDurationChange={jest.fn()}
        availableDurations={[5, 10]}
        selectedResolution="720p"
        onResolutionChange={onResolutionChange}
        availableResolutions={['720p', '1080p']}
        showDuration={false}
      />
    )

    expect(screen.getByTestId('video-settings-trigger')).toHaveTextContent('16:9 · 720P')

    fireEvent.click(screen.getByTestId('video-settings-trigger'))
    expect(screen.queryByTestId('video-duration-option-5')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('video-ratio-option-9:16'))
    expect(onRatioChange).toHaveBeenCalledWith('9:16')

    fireEvent.click(screen.getByTestId('video-resolution-option-1080p'))
    expect(onResolutionChange).toHaveBeenCalledWith('1080p')
  })

  it('keeps the settings accessible while hiding the summary in compact mode', () => {
    render(
      <VideoSettingsPopover
        selectedRatio="16:9"
        onRatioChange={jest.fn()}
        availableRatios={['16:9']}
        selectedDuration={5}
        onDurationChange={jest.fn()}
        availableDurations={[5]}
        selectedResolution="720p"
        onResolutionChange={jest.fn()}
        availableResolutions={['720p']}
        iconOnly
      />
    )

    const trigger = screen.getByTestId('video-settings-trigger')

    expect(trigger).not.toHaveTextContent('16:9')
    expect(trigger.getAttribute('aria-label')).toContain('16:9')
    expect(trigger).toHaveClass('h-9', 'w-9', 'justify-center')
  })
})
