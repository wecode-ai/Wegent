// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PreviewPanel from './PreviewPanel'

// Mock useTranslation hook
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'preview.title': 'Preview',
        'preview.refresh': 'Refresh',
        'preview.close': 'Close preview',
        'preview.start': 'Start Preview',
        'preview.stop': 'Stop Preview',
        'preview.not_configured': 'Preview Not Configured',
        'preview.not_configured_desc': 'Add a .wegent.yaml file to enable preview.',
        'preview.error_title': 'Preview Error',
        'preview.start_server': 'Start Dev Server',
        'preview.start_server_desc': 'Click to start the dev server.',
        'preview.starting': 'Starting Server...',
        'preview.starting_desc': 'Please wait.',
        'preview.retry': 'Retry',
        'preview.status.disabled': 'Disabled',
        'preview.status.starting': 'Starting',
        'preview.status.ready': 'Ready',
        'preview.status.error': 'Error',
        'preview.status.stopped': 'Stopped',
      }
      return translations[key] || key
    },
  }),
}))

// Mock PreviewToolbar
vi.mock('./PreviewToolbar', () => ({
  default: () => <div data-testid="preview-toolbar">PreviewToolbar</div>,
}))

describe('PreviewPanel', () => {
  const defaultProps = {
    isOpen: true,
    url: null,
    status: 'stopped' as const,
    enabled: true,
    viewportSize: 'desktop' as const,
    currentPath: '/',
    error: null,
    isLoading: false,
    taskId: 1,
    onClose: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRefresh: vi.fn(),
    onViewportChange: vi.fn(),
    onNavigate: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<PreviewPanel {...defaultProps} isOpen={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders panel when isOpen is true', () => {
    render(<PreviewPanel {...defaultProps} />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
  })

  it('shows start server button when preview is stopped', () => {
    render(<PreviewPanel {...defaultProps} status="stopped" />)
    expect(screen.getByText('Start Dev Server')).toBeInTheDocument()
    expect(screen.getByText('Start Preview')).toBeInTheDocument()
  })

  it('calls onStart when start button is clicked', () => {
    render(<PreviewPanel {...defaultProps} status="stopped" />)

    const startButton = screen.getByText('Start Preview')
    fireEvent.click(startButton)

    expect(defaultProps.onStart).toHaveBeenCalledTimes(1)
  })

  it('shows loading state when starting', () => {
    render(<PreviewPanel {...defaultProps} status="starting" />)
    expect(screen.getByText('Starting Server...')).toBeInTheDocument()
  })

  it('shows not configured message when preview is disabled', () => {
    render(<PreviewPanel {...defaultProps} enabled={false} />)
    expect(screen.getByText('Preview Not Configured')).toBeInTheDocument()
  })

  it('shows error message when status is error', () => {
    render(
      <PreviewPanel {...defaultProps} status="error" error="Something went wrong" />
    )
    expect(screen.getByText('Preview Error')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('shows iframe when preview is ready', () => {
    render(
      <PreviewPanel
        {...defaultProps}
        status="ready"
        url="http://localhost:3000"
      />
    )

    // Check toolbar is rendered
    expect(screen.getByTestId('preview-toolbar')).toBeInTheDocument()

    // Check iframe exists
    const iframe = screen.getByTitle('Preview')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', 'http://localhost:3000')
  })

  it('calls onClose when close button is clicked', () => {
    render(<PreviewPanel {...defaultProps} />)

    const closeButton = screen.getByTitle('Close preview')
    fireEvent.click(closeButton)

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows stop button when preview is ready', () => {
    render(
      <PreviewPanel
        {...defaultProps}
        status="ready"
        url="http://localhost:3000"
      />
    )

    const stopButton = screen.getByTitle('Stop Preview')
    expect(stopButton).toBeInTheDocument()
  })

  it('calls onStop when stop button is clicked', () => {
    render(
      <PreviewPanel
        {...defaultProps}
        status="ready"
        url="http://localhost:3000"
      />
    )

    const stopButton = screen.getByTitle('Stop Preview')
    fireEvent.click(stopButton)

    expect(defaultProps.onStop).toHaveBeenCalledTimes(1)
  })
})
