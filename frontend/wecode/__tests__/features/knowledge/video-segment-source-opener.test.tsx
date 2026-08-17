// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  resolveVideoSegmentBounds,
  VideoSegmentSource,
} from '@wecode/features/knowledge/video-segment-source-opener'
import { activatePlayer } from '@wecode/features/knowledge/active-video-store'

const mockRetry = jest.fn()
let mockHasError = false

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@wecode/features/knowledge/document-video-preview', () => ({
  useVideoPlayUrl: () => ({
    playUrl: 'https://cdn.example.com/video.mp4',
    coverUrl: null,
    mimeType: 'video/mp4',
    isLoading: false,
    notReady: false,
    hasError: mockHasError,
    retry: mockRetry,
  }),
}))

describe('resolveVideoSegmentBounds', () => {
  beforeEach(() => {
    mockHasError = false
    mockRetry.mockReset()
    jest
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => new Promise<void>(() => {}))
    jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await act(async () => {
      activatePlayer(null)
      await Promise.resolve()
    })
    jest.restoreAllMocks()
  })

  it('clamps only a small encoding tail difference', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 6, end_sec: 11 }, 10)).toEqual({
      startSec: 6,
      endSec: 10,
      duration: 4,
    })
  })

  it('rejects a segment that substantially exceeds the actual duration', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 6, end_sec: 15 }, 10)).toBeNull()
  })

  it('rejects a segment whose start is outside the actual video duration', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 15, end_sec: 20 }, 10)).toBeNull()
  })

  it('rejects an invalid range before media metadata is loaded', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 10, end_sec: 10 })).toBeNull()
  })

  it('corrects model output that shifts MM:SS into HH:MM:SS positions', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 17940, end_sec: 28560 }, 905)).toEqual({
      startSec: 299,
      endSec: 476,
      duration: 177,
    })
  })

  it('corrects a shifted first segment instead of expanding it to the full video', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 0, end_sec: 10680 }, 905)).toEqual({
      startSec: 0,
      endSec: 178,
      duration: 178,
    })
  })

  it('does not reinterpret a valid standard range in a long video', () => {
    expect(resolveVideoSegmentBounds({ start_sec: 17940, end_sec: 28560 }, 30000)).toEqual({
      startSec: 17940,
      endSec: 28560,
      duration: 10620,
    })
  })

  it('renders multiple referenced segments side by side without a selector', () => {
    render(
      <VideoSegmentSource
        source={{
          index: 1,
          title: '811.video.md',
          document_id: 811,
          segments: [
            {
              id: 'segment_0_6',
              start_sec: 0,
              end_sec: 6,
              title: '开场',
              description: '视频开场摘要',
            },
            { id: 'segment_6_15', start_sec: 6, end_sec: 15, title: '趣事' },
          ],
        }}
      />
    )

    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(screen.queryByTestId('video-segment-selector')).not.toBeInTheDocument()
    expect(screen.getByTestId('video-segment-card-0')).toBeInTheDocument()
    expect(screen.getByTestId('video-segment-card-6')).toBeInTheDocument()
    expect(screen.getAllByText(/sourceReferences.videoSegmentTitle/)).toHaveLength(2)
    expect(screen.getByText(/sourceReferences.videoSegmentSummary/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('video-segment-toggle-0'))
    expect(document.querySelectorAll('video')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('video-segment-toggle-6'))
    expect(document.querySelectorAll('video')).toHaveLength(1)
  })

  it('allows a failed signed URL to be refreshed from the active card', () => {
    mockHasError = true
    render(
      <VideoSegmentSource
        source={{
          index: 1,
          title: '811.video.md',
          document_id: 811,
          segments: [{ id: 'segment_0_6', start_sec: 0, end_sec: 6 }],
        }}
      />
    )

    fireEvent.click(screen.getByTestId('video-segment-toggle-0'))
    fireEvent.click(screen.getByTestId('video-segment-card-retry-0'))

    expect(mockRetry).toHaveBeenCalledTimes(1)
  })

  it('activating a segment in one source deactivates players in other sources', () => {
    const makeSource = (index: number, documentId: number) => ({
      index,
      title: `${documentId}.video.md`,
      document_id: documentId,
      segments: [{ id: `segment_0_6`, start_sec: 0, end_sec: 6 }],
    })
    render(
      <>
        <VideoSegmentSource source={makeSource(1, 811)} />
        <VideoSegmentSource source={makeSource(2, 812)} />
      </>
    )

    const toggles = screen.getAllByTestId('video-segment-toggle-0')
    expect(toggles).toHaveLength(2)

    fireEvent.click(toggles[0])
    expect(document.querySelectorAll('video')).toHaveLength(1)

    fireEvent.click(toggles[1])
    expect(document.querySelectorAll('video')).toHaveLength(1)
  })

  it('resumes from the paused position when reactivating a segment', async () => {
    render(
      <VideoSegmentSource
        source={{
          index: 1,
          title: '811.video.md',
          document_id: 811,
          segments: [
            { id: 'segment_0_10', start_sec: 0, end_sec: 10 },
            { id: 'segment_20_30', start_sec: 20, end_sec: 30 },
          ],
        }}
      />
    )

    // Activate the first segment and simulate playback progress to 6s.
    fireEvent.click(screen.getByTestId('video-segment-toggle-0'))
    let video = screen.getByTestId('video-segment-player-0') as HTMLVideoElement
    video.play = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    await act(async () => {
      fireEvent.loadedMetadata(video)
      await Promise.resolve()
    })
    expect(video.currentTime).toBe(0)
    video.currentTime = 6
    fireEvent.timeUpdate(video)

    // Switch to the second segment: the first player unmounts.
    fireEvent.click(screen.getByTestId('video-segment-toggle-20'))
    expect(screen.queryByTestId('video-segment-player-0')).not.toBeInTheDocument()

    // Reactivate the first segment: it resumes at 6s instead of restarting.
    fireEvent.click(screen.getByTestId('video-segment-toggle-0'))
    video = screen.getByTestId('video-segment-player-0') as HTMLVideoElement
    video.play = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 })
    await act(async () => {
      fireEvent.loadedMetadata(video)
      await Promise.resolve()
    })
    expect(video.currentTime).toBe(6)
  })
})
