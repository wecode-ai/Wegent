// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VideoPlayer } from '@/features/tasks/components/message/VideoPlayer'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('VideoPlayer', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.clear()
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

  it('uses a remote cover URL as the video poster', () => {
    const { container } = render(
      <VideoPlayer
        videoUrl="https://example.com/result.mp4"
        coverUrl="https://example.com/cover.jpg"
      />
    )

    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'https://example.com/result.mp4')
    expect(video).toHaveAttribute('poster', 'https://example.com/cover.jpg')
  })

  it('uses a short-lived token for protected attachment playback', async () => {
    localStorage.setItem('auth_token', 'test-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ download_token: 'playback-token' }),
    } as Response) as typeof fetch

    const { container } = render(
      <VideoPlayer videoUrl="/api/attachments/42/download" attachmentId={42} />
    )

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveAttribute(
        'src',
        '/api/attachments/42/download?download_token=playback-token#t=0.001'
      )
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/attachments/42/download-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    })
  })

  it('places the download action in the top-right overlay', () => {
    render(<VideoPlayer videoUrl="https://example.com/result.mp4" />)

    const download = screen.getByTestId('generated-video-download')
    expect(download.parentElement).toHaveClass('absolute', 'right-2', 'top-2')
    expect(download.closest('.absolute.bottom-0')).toBeNull()
  })

  it.each([
    { label: 'landscape', videoWidth: 1280, videoHeight: 720, width: '359px', height: '202px' },
    { label: 'portrait', videoWidth: 720, videoHeight: 1280, width: '202px', height: '359px' },
    { label: 'square', videoWidth: 1024, videoHeight: 1024, width: '202px', height: '202px' },
  ])('uses the compact message size for $label video', dimensions => {
    const { container } = render(
      <VideoPlayer videoUrl="https://example.com/result.mp4" useMessageDisplaySize />
    )
    const player = screen.getByTestId('generated-video-player')
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperties(video, {
      videoWidth: {
        configurable: true,
        value: dimensions.videoWidth,
      },
      videoHeight: {
        configurable: true,
        value: dimensions.videoHeight,
      },
    })

    fireEvent.loadedMetadata(video)

    expect(player).toHaveStyle({
      width: dimensions.width,
      height: dimensions.height,
    })
    expect(video).toHaveClass('h-full', 'object-contain')
  })

  it('shows a compact placeholder until the message video aspect ratio is known', () => {
    const { container } = render(
      <VideoPlayer videoUrl="https://example.com/result.mp4" useMessageDisplaySize />
    )
    const player = screen.getByTestId('generated-video-player')
    const video = container.querySelector('video') as HTMLVideoElement

    expect(player).toHaveStyle({
      width: '202px',
      height: '202px',
    })
    expect(screen.getByTestId('video-metadata-placeholder')).toHaveAccessibleName('video.loading')
    expect(video).toHaveClass('opacity-0')

    Object.defineProperties(video, {
      videoWidth: {
        configurable: true,
        value: 720,
      },
      videoHeight: {
        configurable: true,
        value: 1280,
      },
    })
    fireEvent.loadedMetadata(video)

    expect(player).toHaveStyle({
      width: '202px',
      height: '359px',
    })
    expect(screen.queryByTestId('video-metadata-placeholder')).not.toBeInTheDocument()
    expect(video).not.toHaveClass('opacity-0')
  })

  it('seeks backward and forward with the arrow keys', () => {
    const { container } = render(
      <VideoPlayer videoUrl="https://example.com/result.mp4" duration={20} />
    )
    const player = screen.getByTestId('generated-video-player')
    const video = container.querySelector('video') as HTMLVideoElement

    video.currentTime = 10
    fireEvent.keyDown(player, { key: 'ArrowLeft' })
    expect(video.currentTime).toBe(5)

    fireEvent.keyDown(player, { key: 'ArrowRight' })
    expect(video.currentTime).toBe(10)

    video.currentTime = 18
    fireEvent.keyDown(player, { key: 'ArrowRight' })
    expect(video.currentTime).toBe(20)

    video.currentTime = 2
    fireEvent.keyDown(player, { key: 'ArrowLeft' })
    expect(video.currentTime).toBe(0)
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

    const { container } = render(<VideoPlayer videoUrl="https://example.com/result.mp4" />)

    const overlay = screen.getByTestId('video-toggle-overlay')
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'paused', {
      configurable: true,
      value: true,
    })

    fireEvent.click(overlay)
    expect(play).toHaveBeenCalledTimes(1)
    expect(
      screen.getByTestId('video-playback-feedback').querySelector('.lucide-play')
    ).not.toBeNull()

    Object.defineProperty(video, 'paused', {
      configurable: true,
      value: false,
    })
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

  it('restarts an ended video before replaying it', () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const { container } = render(<VideoPlayer videoUrl="https://example.com/result.mp4" />)
    const video = container.querySelector('video') as HTMLVideoElement

    Object.defineProperties(video, {
      paused: {
        configurable: true,
        value: true,
      },
      ended: {
        configurable: true,
        value: true,
      },
    })
    video.currentTime = 12

    fireEvent.click(screen.getByTestId('video-toggle-overlay'))

    expect(video.currentTime).toBe(0)
    expect(play).toHaveBeenCalledTimes(1)
  })
})
