// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import VideoSettingsPopover from '@/features/tasks/components/selector/VideoSettingsPopover'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('VideoSettingsPopover', () => {
  it('keeps unowned controls while hiding configured video parameters', () => {
    const onResolutionChange = jest.fn()

    render(
      <VideoSettingsPopover
        selectedRatio="16:9"
        onRatioChange={jest.fn()}
        availableRatios={['16:9', '9:16']}
        selectedDuration={5}
        onDurationChange={jest.fn()}
        availableDurations={[5, 10]}
        selectedResolution="720p"
        onResolutionChange={onResolutionChange}
        availableResolutions={['720p', '1080p']}
        hiddenVideoParams={['duration', 'ratio']}
      />
    )

    expect(screen.getByTestId('video-settings-trigger')).toHaveTextContent('720P')

    fireEvent.click(screen.getByTestId('video-settings-trigger'))
    expect(screen.queryByTestId('video-duration-option-5')).not.toBeInTheDocument()
    expect(screen.getByTestId('video-ratio-option-9:16')).not.toBeVisible()

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

  it('labels the mobile menu item before showing its current values', () => {
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
        triggerVariant="menu-item"
      />
    )

    const trigger = screen.getByTestId('video-settings-trigger')

    expect(trigger).toHaveTextContent('video.settings_title')
    expect(trigger).toHaveTextContent('16:9 · 5S · 720P')
    expect(trigger).toHaveClass('min-h-14', 'w-full')
  })

  it('hides the settings trigger when every video parameter is hidden', () => {
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
        hiddenVideoParams={['duration', 'ratio', 'resolution']}
      />
    )

    expect(screen.queryByTestId('video-settings-trigger')).not.toBeInTheDocument()
  })
})
