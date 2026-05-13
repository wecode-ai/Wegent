// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import fs from 'node:fs'
import path from 'node:path'
import { act, render, screen } from '@testing-library/react'

import StreamingWaitIndicator from '@/features/tasks/components/message/StreamingWaitIndicator'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const readGlobalCss = () => fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')

const getCssRule = (css: string, selector: string) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = Array.from(
    css.matchAll(new RegExp(`${escapedSelector} \\{([\\s\\S]*?)\\n\\}`, 'g'))
  )
  return matches.at(-1)?.[1] ?? ''
}

describe('StreamingWaitIndicator', () => {
  it('uses one animated purple runner dot instead of the old three-dot typing indicator', () => {
    render(<StreamingWaitIndicator isWaiting={true} />)

    const indicator = screen.getByTestId('streaming-wait-indicator')
    const track = screen.getByTestId('streaming-wait-runner-track')
    const dot = screen.getByTestId('streaming-wait-runner-dot')

    expect(indicator).toContainElement(track)
    expect(track).toContainElement(dot)
    expect(dot).toHaveClass('streaming-wait-runner-dot')
    expect(track.querySelectorAll('[data-testid="streaming-wait-runner-dot"]')).toHaveLength(1)
    expect(indicator.querySelectorAll('.animate-pulse')).toHaveLength(0)
  })

  it('can render a fixed message while reusing the runner animation', () => {
    render(<StreamingWaitIndicator isWaiting={true} message="thinking.processing" />)

    const indicator = screen.getByTestId('streaming-wait-indicator')

    expect(screen.getByTestId('streaming-wait-runner-dot')).toBeInTheDocument()
    expect(indicator.querySelectorAll('.animate-pulse')).toHaveLength(0)
    expect(screen.getAllByText('thinking.processing')).toHaveLength(2)
  })

  it('keeps the runner dot as one continuous shape instead of split top and bottom pieces', () => {
    const css = readGlobalCss()

    expect(css).not.toContain('.streaming-wait-runner-dot::before')
    expect(css).not.toContain('.streaming-wait-runner-dot::after')
  })

  it('keeps horizontal travel continuous without mid-route position stops', () => {
    const css = readGlobalCss()

    expect(css).not.toContain('left: 36%')
    expect(css).not.toContain('left: 68%')
  })

  it('clips the moving runner highlight to text glyphs while it crosses the message', () => {
    render(<StreamingWaitIndicator isWaiting={true} />)

    const css = readGlobalCss()
    const trackRule = getCssRule(css, '.streaming-wait-runner-track')
    const textMask = screen.getByTestId('streaming-wait-runner-text-mask')
    const maskRule = css.slice(
      css.indexOf('.streaming-wait-runner-text-mask {\n  position: absolute')
    )

    expect(textMask).toHaveAttribute('aria-hidden', 'true')
    expect(textMask).toHaveTextContent('tasks:streaming_wait.thinking')
    expect(trackRule).toContain('--runner-dot-size: 0.75rem')
    expect(maskRule).toContain('background-clip: text')
    expect(maskRule).toContain('-webkit-text-fill-color: transparent')
  })

  it('changes progressive text only after a full runner animation lap completes', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-05-13T00:00:00.000Z'))

    render(<StreamingWaitIndicator isWaiting={true} />)

    expect(screen.getAllByText('tasks:streaming_wait.thinking')).toHaveLength(2)

    act(() => {
      jest.advanceTimersByTime(5300)
    })

    expect(screen.getAllByText('tasks:streaming_wait.thinking')).toHaveLength(2)

    act(() => {
      jest.advanceTimersByTime(100)
    })

    expect(screen.getAllByText('tasks:streaming_wait.analyzing')).toHaveLength(2)

    jest.useRealTimers()
  })

  it('positions the runner one pixel below the text centerline', () => {
    const css = readGlobalCss()
    const trackRule = getCssRule(css, '.streaming-wait-runner-track')
    const dotRule = getCssRule(css, '.streaming-wait-runner-dot')

    expect(trackRule).toContain('--runner-y-offset: 1px')
    expect(dotRule).toContain('top: calc(50% + var(--runner-y-offset))')
  })

  it('adds two playful hops while the runner pauses on the right side', () => {
    const css = readGlobalCss()

    expect(css).toMatch(
      /38%,\s+44% \{[\s\S]*translateY\(-50%\) translateY\(-4px\) scaleX\(0\.94\) scaleY\(1\.08\)/
    )
    expect(css).toMatch(
      /41%,\s+47% \{[\s\S]*translateY\(-50%\) translateY\(1px\) scaleX\(1\.16\) scaleY\(0\.84\)/
    )
  })

  it('waits about 0.5 seconds on the right side before hopping', () => {
    const css = readGlobalCss()
    const dotRule = getCssRule(css, '.streaming-wait-runner-dot')
    const maskRule = css.slice(
      css.indexOf('.streaming-wait-runner-text-mask {\n  position: absolute')
    )

    expect(dotRule).toContain('animation: streaming-wait-runner-travel 5.4s linear infinite')
    expect(maskRule).toContain('animation: streaming-wait-runner-text-mask 5.4s linear infinite')
    expect(css).toMatch(
      /26%,\s+35% \{[\s\S]*left: calc\(100% - var\(--runner-dot-size\)\);[\s\S]*transform: translateY\(-50%\) scale\(1\);/
    )
  })
})
