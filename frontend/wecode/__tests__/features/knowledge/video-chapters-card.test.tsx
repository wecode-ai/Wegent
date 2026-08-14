// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { VideoChaptersCard } from '@wecode/features/knowledge/video-chapters-card'
import { VideoSegmentSource } from '@wecode/features/knowledge/video-segment-source-opener'
import { activatePlayer } from '@wecode/features/knowledge/active-video-store'

const mockRetry = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@wecode/features/knowledge/document-video-preview', () => ({
  useVideoPlayUrl: () => ({
    playUrl: 'https://cdn.example.com/video.mp4',
    mimeType: 'video/mp4',
    isLoading: false,
    notReady: false,
    hasError: false,
    retry: mockRetry,
  }),
}))

describe('VideoChaptersCard', () => {
  beforeEach(() => {
    mockRetry.mockClear()
  })

  afterEach(() => {
    activatePlayer(null)
  })

  it('rejects a chapter outside the actual media duration', () => {
    render(
      <VideoChaptersCard
        source={{
          index: 1,
          title: 'video.mp4',
          kb_id: 211,
          document_id: 811,
          segments: [{ start_sec: 60, end_sec: 90, title: 'Invalid chapter' }],
        }}
      />
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    const video = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
    fireEvent.loadedMetadata(video)

    expect(screen.getByText('sourceReferences.invalidVideoSegmentRange')).toBeInTheDocument()
    expect(screen.getByTestId('video-chapter-item-1-0')).toBeDisabled()
  })

  it('restores the selected chapter after retry reloads metadata', () => {
    render(
      <VideoChaptersCard
        source={{
          index: 1,
          title: 'video.mp4',
          kb_id: 211,
          document_id: 811,
          segments: [
            { start_sec: 0, end_sec: 10, title: 'First' },
            { start_sec: 20, end_sec: 30, title: 'Second' },
          ],
        }}
      />
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    const video = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    fireEvent.loadedMetadata(video)
    fireEvent.click(screen.getByTestId('video-chapter-item-1-1'))
    expect(video.currentTime).toBe(20)

    fireEvent.error(video)
    fireEvent.click(screen.getByTestId('video-chapters-error-retry-1'))
    expect(mockRetry).toHaveBeenCalledTimes(1)

    const retriedVideo = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(retriedVideo, 'duration', { configurable: true, value: 60 })
    fireEvent.loadedMetadata(retriedVideo)
    expect(retriedVideo.currentTime).toBe(20)
  })

  it('seeks via the timeline and activates the containing chapter', () => {
    render(
      <VideoChaptersCard
        source={{
          index: 1,
          title: 'video.mp4',
          kb_id: 211,
          document_id: 811,
          segments: [
            { start_sec: 0, end_sec: 10, title: 'First' },
            { start_sec: 20, end_sec: 30, title: 'Second' },
          ],
        }}
      />
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    const video = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    fireEvent.loadedMetadata(video)

    const slider = screen.getByTestId('video-chapters-progress-1')
    expect(slider).toHaveAttribute('max', '60')

    fireEvent.change(slider, { target: { value: '25' } })
    expect(video.currentTime).toBe(25)
    expect(screen.getByTestId('video-chapter-item-1-1').className).toContain('bg-primary/10')
  })

  it('plays directly when a chapter is clicked', () => {
    render(
      <VideoChaptersCard
        source={{
          index: 1,
          title: 'video.mp4',
          kb_id: 211,
          document_id: 811,
          segments: [
            { start_sec: 0, end_sec: 10, title: 'First' },
            { start_sec: 20, end_sec: 30, title: 'Second' },
          ],
        }}
      />
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    const video = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    const playMock = jest.fn().mockResolvedValue(undefined)
    video.play = playMock
    fireEvent.loadedMetadata(video)

    fireEvent.click(screen.getByTestId('video-chapter-item-1-1'))

    expect(video.currentTime).toBe(20)
    expect(playMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a single player across chapters cards and segment sources', () => {
    const chaptersSource = (index: number, documentId: number) => ({
      index,
      title: `${documentId}.mp4`,
      kb_id: 211,
      document_id: documentId,
      segments: [{ start_sec: 0, end_sec: 10, title: 'Chapter' }],
    })
    render(
      <>
        <VideoChaptersCard source={chaptersSource(1, 811)} />
        <VideoChaptersCard source={chaptersSource(2, 812)} />
        <VideoSegmentSource
          source={{
            index: 3,
            title: '813.video.md',
            document_id: 813,
            segments: [{ id: 'segment_0_6', start_sec: 0, end_sec: 6 }],
          }}
        />
      </>
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    expect(document.querySelectorAll('video')).toHaveLength(1)

    // A segment card in another source replaces the chapters player.
    fireEvent.click(screen.getByTestId('video-segment-toggle-0'))
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(screen.queryByTestId('video-chapters-card-1')).not.toBeInTheDocument()

    // A second chapters card replaces the segment player.
    fireEvent.click(screen.getByTestId('video-chapters-toggle-2'))
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(screen.queryByTestId('video-segment-player-0')).not.toBeInTheDocument()
  })

  it('shows the play icon again after collapsing a playing card and reopening it', async () => {
    const chaptersSource = (index: number, documentId: number) => ({
      index,
      title: `${documentId}.mp4`,
      kb_id: 211,
      document_id: documentId,
      segments: [{ start_sec: 0, end_sec: 10, title: 'Chapter' }],
    })
    render(
      <>
        <VideoChaptersCard source={chaptersSource(1, 811)} />
        <VideoChaptersCard source={chaptersSource(2, 812)} />
      </>
    )

    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    const video = screen.getByTestId('video-chapters-player-1') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    video.play = jest.fn().mockResolvedValue(undefined)
    video.pause = jest.fn()
    fireEvent.loadedMetadata(video)

    fireEvent.click(screen.getByTestId('video-chapters-control-toggle-1'))
    await screen.findAllByLabelText('sourceReferences.pauseVideoSegment')

    // Another card takes over: the first card collapses.
    fireEvent.click(screen.getByTestId('video-chapters-toggle-2'))
    expect(screen.queryByTestId('video-chapters-card-1')).not.toBeInTheDocument()

    // Reopen the first card: it must show the play icon, not a stale pause icon.
    fireEvent.click(screen.getByTestId('video-chapters-toggle-1'))
    expect(screen.getByTestId('video-chapters-control-toggle-1').getAttribute('aria-label')).toBe(
      'sourceReferences.playVideoSegment'
    )
  })
})
