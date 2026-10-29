// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { VideoPreview } from '@/components/common/FilePreview/preview-renderers/VideoPreview'

describe('VideoPreview', () => {
  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('keeps the remote source attached during the React Strict Mode effect replay', () => {
    const url = 'https://cdn.example.com/video.mp4'
    const { container } = render(
      <StrictMode>
        <VideoPreview url={url} restricted />
      </StrictMode>
    )

    expect(container.querySelector('video')).toHaveAttribute('src', url)
  })

  it('contains the video inside the available preview viewport', () => {
    const { container } = render(<VideoPreview url="https://cdn.example.com/portrait.mp4" />)

    const viewport = container.firstElementChild?.firstElementChild
    const video = container.querySelector('video')
    expect(viewport).toHaveClass('min-h-0', 'min-w-0', 'overflow-hidden')
    expect(video).toHaveClass('h-full', 'w-full', 'object-contain')
  })
})
