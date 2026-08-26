// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ClipTimeline } from '@wecode/features/video/composition/ClipTimeline'
import type { CompositionClip } from '@wecode/features/video/composition/types'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = ResizeObserverMock

// VideoFilmstrip loads real video elements which are heavy and unreliable in
// jsdom; stub it so the timeline layout can be tested in isolation.
jest.mock('@wecode/features/video/composition/VideoFilmstrip', () => ({
  VideoFilmstrip: () => <div data-testid="filmstrip-stub" />,
}))

const baseClip = (clipId: number): CompositionClip => ({
  storyboard_id: 1,
  clip_id: clipId,
  order: clipId,
  source_duration: 5,
  trim_start: 0,
  trim_end: 5,
  volume: 1,
  enabled: true,
})

function renderTimeline(overrides: { onOpenCoverPicker?: () => void } = {}) {
  const props = {
    clips: [baseClip(1), baseClip(2)],
    clipCoverUrlMap: { 1: 'https://cover/1.jpg', 2: 'https://cover/2.jpg' },
    clipVideoUrlMap: { 1: 'https://video/1.mp4', 2: 'https://video/2.mp4' },
    clipDurationMap: { 1: 5, 2: 5 },
    subtitles: [],
    selectedClipIndex: null,
    onSelectClip: jest.fn(),
    onTrimClip: jest.fn(),
    onOpenCoverPicker: jest.fn(),
    onMusicClick: jest.fn(),
    ...overrides,
  }
  return render(<ClipTimeline {...props} />)
}

describe('ClipTimeline — cover button (design spec)', () => {
  it('renders a dedicated 视频 track label in the label column', () => {
    // Per design spec, the video track has its own label (视频) in the label
    // column, separate from the cover button.
    renderTimeline()
    expect(screen.getByText('视频')).toBeInTheDocument()
  })

  it('renders the cover button labeled 封面', () => {
    renderTimeline()
    expect(screen.getByText('封面')).toBeInTheDocument()
  })

  it('renders the cover button as an SVG pencil icon, not a lucide Pencil', () => {
    // The design uses a hand-drawn pencil SVG (two <path> strokes), not the
    // lucide Pencil icon. The cover button must contain an inline <svg>.
    renderTimeline()
    const coverButton = screen.getByText('封面').closest('button')
    expect(coverButton).toBeTruthy()
    const svg = coverButton!.querySelector('svg')
    expect(svg).toBeTruthy()
    // The pencil body path (the diagonal stroke ending in a triangle tip).
    const paths = svg!.querySelectorAll('path')
    expect(paths.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the cover button out of the label column (label column only holds track labels)', () => {
    // Per design, the cover button sits in its own fixed column between the
    // track-label column and the scrollable video track — it must NOT be inside
    // the label column (which holds the 视频 label) and must NOT overlap the
    // clip thumbnails (which live in the scroll viewport).
    renderTimeline()
    const coverButton = screen.getByText('封面').closest('button')
    expect(coverButton).toBeTruthy()
    const videoLabel = screen.getByText('视频')
    const labelColumn = videoLabel.closest('div')
    expect(labelColumn).toBeTruthy()
    // Cover button is not inside the label column.
    expect(labelColumn!.contains(coverButton!)).toBe(false)
    // Cover button is also not inside the scroll viewport (clips area).
    const scrollViewport = document.querySelector('[data-testid="timeline-tracks-scroll-viewport"]')
    expect(scrollViewport).toBeTruthy()
    expect(scrollViewport!.contains(coverButton!)).toBe(false)
  })

  it('invokes onOpenCoverPicker when the cover button is clicked', () => {
    const onOpenCoverPicker = jest.fn()
    renderTimeline({ onOpenCoverPicker })
    const coverButton = screen.getByText('封面').closest('button')
    expect(coverButton).toBeTruthy()
    fireEvent.click(coverButton!)
    expect(onOpenCoverPicker).toHaveBeenCalled()
  })

  it('hides the cover button when onOpenCoverPicker is not provided (read-only)', () => {
    // In read-only mode the cover button is not rendered.
    renderTimeline({ onOpenCoverPicker: undefined })
    expect(screen.queryByText('封面')).not.toBeInTheDocument()
  })
})
