// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import VideoGenerationModeSelector from '@/features/tasks/components/selector/VideoGenerationModeSelector'

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
})
