// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import VideoGenerationModeSelector from '@/features/tasks/components/selector/VideoGenerationModeSelector'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'video.generation_mode_section' ? '视频模式' : key),
  }),
}))

describe('VideoGenerationModeSelector', () => {
  it('renders the selected mode as a labeled menu item', () => {
    render(
      <VideoGenerationModeSelector
        modes={[
          { id: 'text_to_video', label: '文生视频' },
          { id: 'omni_reference', label: '全能参考' },
        ]}
        value="omni_reference"
        onChange={jest.fn()}
        triggerVariant="menu-item"
      />
    )

    const trigger = screen.getByTestId('video-generation-mode-selector')

    expect(trigger).toHaveTextContent('全能参考')
    expect(trigger).toHaveClass('h-11', 'w-full', 'rounded-md')
  })

  it('renders mobile video modes inline without a nested popover', () => {
    const onChange = jest.fn()

    render(
      <VideoGenerationModeSelector
        modes={[
          { id: 'omni_reference', label: '全能模式' },
          { id: 'first_last_frame', label: '首尾帧' },
        ]}
        value="omni_reference"
        onChange={onChange}
        inline
      />
    )

    expect(screen.getByTestId('video-generation-mode-options')).toHaveTextContent('视频模式')
    expect(screen.queryByTestId('video-generation-mode-selector')).not.toBeInTheDocument()
    expect(screen.getByTestId('video-generation-mode-omni_reference')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(screen.getByTestId('video-generation-mode-first_last_frame'))
    expect(onChange).toHaveBeenCalledWith('first_last_frame')
  })
})
