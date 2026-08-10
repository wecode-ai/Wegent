// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { VideoPlayer } from '@/features/tasks/components/message/VideoPlayer'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('VideoPlayer', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('loads the first video frame when no thumbnail is available', () => {
    const { container } = render(<VideoPlayer videoUrl="https://example.com/result.mp4" />)

    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'https://example.com/result.mp4#t=0.001')
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('poster')
  })

  it('renders a compact generation placeholder with progress only', () => {
    render(<VideoPlayer videoUrl="" isPlaceholder progress={37} />)

    const placeholder = screen.getByTestId('video-generation-placeholder')
    expect(placeholder).toHaveAccessibleName('video.generating 37%')
    expect(placeholder).toHaveTextContent('37%')
    expect(placeholder).not.toHaveTextContent('video.generating')
    expect(placeholder).not.toHaveTextContent('video.preparing')
  })

  it('shows transient play and pause feedback when the video is clicked', () => {
    jest.useFakeTimers()
    const play = jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation()

    render(<VideoPlayer videoUrl="https://example.com/result.mp4" />)

    const overlay = screen.getByTestId('video-toggle-overlay')
    fireEvent.click(overlay)
    expect(play).toHaveBeenCalledTimes(1)
    expect(
      screen.getByTestId('video-playback-feedback').querySelector('.lucide-play')
    ).not.toBeNull()

    fireEvent.click(overlay)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(
      screen.getByTestId('video-playback-feedback').querySelector('.lucide-pause')
    ).not.toBeNull()

    act(() => {
      jest.advanceTimersByTime(450)
    })
    expect(screen.queryByTestId('video-playback-feedback')).not.toBeInTheDocument()
  })
})
