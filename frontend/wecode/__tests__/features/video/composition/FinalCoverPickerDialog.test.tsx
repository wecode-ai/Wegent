// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FinalCoverPickerDialog } from '@wecode/features/video/composition/FinalCoverPickerDialog'
import type { CompositionClip } from '@wecode/features/video/composition/types'
import type { FinalVideoCover } from '@wecode/features/video/script/types'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = ResizeObserverMock

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// VideoFilmstripSelector loads real video elements which are heavy and
// unreliable in jsdom; stub it so the dialog layout can be tested in isolation.
jest.mock('@wecode/features/video/composition/VideoFilmstrip', () => ({
  VideoFilmstripSelector: (props: {
    clipId: number
    onSelectTime?: (time: number, previewUrl?: string) => void
  }) => (
    <div
      data-testid={`filmstrip-${props.clipId}`}
      onClick={() => props.onSelectTime?.(1.5, 'https://preview.example/x.jpg')}
    />
  ),
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

function renderDialog(
  overrides: {
    ratio?: string
    finalVideoCover?: FinalVideoCover | null
    localPreviewUrl?: string | null
  } = {}
) {
  const props = {
    open: true,
    clips: [baseClip(1), baseClip(2)],
    clipCoverUrlMap: { 1: 'https://cover/1.jpg', 2: 'https://cover/2.jpg' },
    clipVideoUrlMap: { 1: 'https://video/1.mp4', 2: 'https://video/2.mp4' },
    clipDurationMap: { 1: 5, 2: 5 },
    finalVideoCover: null,
    localPreviewUrl: null,
    ratio: '16:9' as string,
    onOpenChange: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides,
  }
  return render(<FinalCoverPickerDialog {...props} />)
}

describe('FinalCoverPickerDialog — design spec layout', () => {
  // Radix Dialog portals into document.body, so queries must use document.body
  // rather than the render container.
  it('renders the dialog with a fixed 1000px width', () => {
    renderDialog()
    // DialogContent is the main panel; design spec pins it to 1000px wide.
    const panel = document.body.querySelector('[role="dialog"]') as HTMLElement
    expect(panel).toBeTruthy()
    // The inline style sets width: '1000px' per design spec.
    expect(panel.style.width).toBe('1000px')
  })

  it('shows the title "封面设计" and a close button', () => {
    renderDialog()
    expect(screen.getByText('封面设计')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('renders the zoom slider in the timeline toolbar', () => {
    renderDialog()
    const slider = document.body.querySelector('[role="slider"]')
    expect(slider).toBeInTheDocument()
    expect(slider).toHaveAttribute('aria-valuemin', '1')
    expect(slider).toHaveAttribute('aria-valuemax', '2')
  })

  it('renders the preview area with a fixed 738x415 box', () => {
    renderDialog()
    const previewBox = document.body.querySelector(
      '[data-testid="cover-preview-box"]'
    ) as HTMLElement
    expect(previewBox).toBeTruthy()
    expect(previewBox.style.width).toBe('738px')
    expect(previewBox.style.height).toBe('415px')
    expect(previewBox.style.borderRadius).toBe('10px')
  })

  it('uses the orange #ff8200 background for the confirm button', () => {
    renderDialog()
    const confirmBtn = screen.getByRole('button', { name: '设为封面' })
    // Per design spec the confirm button is filled with #ff8200 (applied via
    // the bg-[#ff8200] utility class).
    expect(confirmBtn.className).toContain('bg-[#ff8200]')
  })

  it('uses a white background for the cancel button', () => {
    renderDialog()
    const cancelBtn = screen.getByRole('button', { name: '取消' })
    expect(cancelBtn.className).toContain('bg-white')
  })

  it('centers the footer action buttons', () => {
    renderDialog()
    const cancelBtn = screen.getByRole('button', { name: '取消' })
    const footer = cancelBtn.parentElement
    expect(footer).toBeTruthy()
    expect(footer!.className).toContain('justify-center')
  })

  describe('no prior cover selection', () => {
    it('defaults the preview to the first clip cover when no cover is set', () => {
      renderDialog()
      const innerMedia = document.body.querySelector(
        '[data-testid="cover-preview-media"]'
      ) as HTMLElement
      // With no saved cover, the preview should default to the first clip's
      // cover image instead of showing the placeholder text.
      expect(innerMedia).toBeTruthy()
      expect(innerMedia.tagName.toLowerCase()).toBe('img')
      expect((innerMedia as HTMLImageElement).getAttribute('src')).toBe('https://cover/1.jpg')
    })
  })

  describe('vertical (9:16) video', () => {
    it('keeps the outer box 738x415 and centers a vertical inner media', () => {
      // Pre-select a clip so media renders.
      const savedCover: FinalVideoCover = {
        clip_id: 1,
        cover_time_in_source: 1.5,
        cover_url: 'https://cover/1.jpg',
      } as FinalVideoCover
      renderDialog({ ratio: '9:16', finalVideoCover: savedCover })
      const previewBox = document.body.querySelector(
        '[data-testid="cover-preview-box"]'
      ) as HTMLElement
      // Outer box stays the design-spec horizontal size even for vertical video.
      expect(previewBox.style.width).toBe('738px')
      expect(previewBox.style.height).toBe('415px')

      const innerMedia = document.body.querySelector(
        '[data-testid="cover-preview-media"]'
      ) as HTMLElement
      expect(innerMedia).toBeTruthy()
      // Vertical video: height fills the box, width is the proportional
      // horizontal size (9/16 * 415 ≈ 233px), centered horizontally.
      expect(innerMedia.style.height).toBe('415px')
    })
  })

  describe('horizontal (16:9) video', () => {
    it('fills the 738x415 box with the media', () => {
      const savedCover: FinalVideoCover = {
        clip_id: 1,
        cover_time_in_source: 1.5,
        cover_url: 'https://cover/1.jpg',
      } as FinalVideoCover
      renderDialog({ ratio: '16:9', finalVideoCover: savedCover })
      const innerMedia = document.body.querySelector(
        '[data-testid="cover-preview-media"]'
      ) as HTMLElement
      expect(innerMedia).toBeTruthy()
      expect(innerMedia.style.width).toBe('738px')
      expect(innerMedia.style.height).toBe('415px')
    })
  })
})
