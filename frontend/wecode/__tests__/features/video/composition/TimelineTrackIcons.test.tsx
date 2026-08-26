// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  IconAudio,
  IconSubtitle,
  IconVideo,
} from '@wecode/features/video/composition/TimelineTrackIcons'

describe('TimelineTrackIcons — design spec', () => {
  it.each([
    ['IconVideo', IconVideo, 2],
    ['IconSubtitle', IconSubtitle, 2],
    ['IconAudio', IconAudio, 3],
  ])(
    '%s renders a 16x16 svg with the expected shape elements',
    (name, Component, expectedPaths) => {
      render(<Component data-testid={`icon-${name.toLowerCase()}`} />)
      const svg = screen.getByTestId(`icon-${name.toLowerCase()}`)
      expect(svg.tagName).toBe('svg')
      expect(svg).toHaveAttribute('viewBox', '0 0 16 16')
      expect(svg.querySelectorAll('path')).toHaveLength(expectedPaths)
    }
  )

  it('uses #333333 stroke by default', () => {
    render(<IconVideo data-testid="icon-video" />)
    const paths = screen.getByTestId('icon-video').querySelectorAll('path')
    paths.forEach(path => {
      expect(path).toHaveAttribute('stroke', '#333333')
    })
  })

  it('accepts a custom color', () => {
    render(<IconAudio data-testid="icon-audio" color="#ff8200" />)
    const paths = screen.getByTestId('icon-audio').querySelectorAll('path')
    paths.forEach(path => {
      expect(path).toHaveAttribute('stroke', '#ff8200')
    })
  })
})
