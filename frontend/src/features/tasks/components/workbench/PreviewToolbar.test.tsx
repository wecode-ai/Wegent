// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PreviewToolbar from './PreviewToolbar'

// Mock useTranslation hook
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'preview.refresh': 'Refresh',
      }
      return translations[key] || key
    },
  }),
}))

describe('PreviewToolbar', () => {
  const defaultProps = {
    currentPath: '/',
    viewportSize: 'desktop' as const,
    isLoading: false,
    onRefresh: vi.fn(),
    onViewportChange: vi.fn(),
    onNavigate: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders toolbar with all controls', () => {
    render(<PreviewToolbar {...defaultProps} />)

    // Check refresh button exists
    expect(screen.getByTitle('Refresh')).toBeInTheDocument()

    // Check URL input exists
    expect(screen.getByPlaceholderText('/')).toBeInTheDocument()

    // Check viewport buttons exist (via icons)
    expect(screen.getByTitle('Desktop')).toBeInTheDocument()
    expect(screen.getByTitle('Tablet')).toBeInTheDocument()
    expect(screen.getByTitle('Mobile')).toBeInTheDocument()
  })

  it('calls onRefresh when refresh button is clicked', () => {
    render(<PreviewToolbar {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh')
    fireEvent.click(refreshButton)

    expect(defaultProps.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('calls onViewportChange when viewport button is clicked', () => {
    render(<PreviewToolbar {...defaultProps} />)

    const tabletButton = screen.getByTitle('Tablet')
    fireEvent.click(tabletButton)

    expect(defaultProps.onViewportChange).toHaveBeenCalledWith('tablet')
  })

  it('calls onNavigate when Enter is pressed in URL input', () => {
    render(<PreviewToolbar {...defaultProps} />)

    const input = screen.getByPlaceholderText('/')
    fireEvent.change(input, { target: { value: '/about' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(defaultProps.onNavigate).toHaveBeenCalledWith('/about')
  })

  it('disables refresh button when loading', () => {
    render(<PreviewToolbar {...defaultProps} isLoading={true} />)

    const refreshButton = screen.getByTitle('Refresh')
    expect(refreshButton).toBeDisabled()
  })

  it('highlights active viewport button', () => {
    render(<PreviewToolbar {...defaultProps} viewportSize="tablet" />)

    const tabletButton = screen.getByTitle('Tablet')
    expect(tabletButton.className).toContain('text-primary')
  })
})
