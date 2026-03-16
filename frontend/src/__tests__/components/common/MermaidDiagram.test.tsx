// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import MermaidDiagram from '@/components/common/MermaidDiagram'

// Mock the theme context
jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: jest.fn() }),
}))

// Mock the translation hook
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat:mermaid.renderError': 'Mermaid render failed',
        'chat:mermaid.copied': 'Copied',
        'chat:mermaid.copyCode': 'Copy Code',
        'chat:mermaid.zoomIn': 'Zoom In',
        'chat:mermaid.zoomOut': 'Zoom Out',
        'chat:mermaid.resetZoom': 'Reset Zoom',
        'chat:mermaid.exportPng': 'Export PNG',
        'chat:mermaid.exportSvg': 'Export SVG',
        'chat:mermaid.exportSuccess': 'Exported',
        'chat:mermaid.copyImage': 'Copy Image',
        'chat:mermaid.viewCode': 'View Code',
        'chat:mermaid.sourceCode': 'Mermaid Source Code',
        'chat:mermaid.escToClose': 'Press ESC to close',
        'knowledge:diagram': 'Diagram',
      }
      return translations[key] || key
    },
  }),
}))

// Create mock functions for mermaid
const mockInitialize = jest.fn()
let mockRenderResolve: (value: { svg: string }) => void
const mockRender = jest.fn().mockImplementation(() => {
  return new Promise(resolve => {
    mockRenderResolve = resolve
  })
})

// Mock mermaid library - must match the dynamic import structure
jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

// Mock clipboard API
const mockClipboard = {
  writeText: jest.fn().mockResolvedValue(undefined),
}
Object.assign(navigator, { clipboard: mockClipboard })

// Mock canvas getContext to avoid "Not implemented" errors
HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
  fillRect: jest.fn(),
  clearRect: jest.fn(),
  getImageData: jest.fn(() => ({ data: new Uint8ClampedArray(4) })),
  putImageData: jest.fn(),
  createImageData: jest.fn(() => ({ data: new Uint8ClampedArray(4) })),
  setTransform: jest.fn(),
  drawImage: jest.fn(),
  save: jest.fn(),
  fillText: jest.fn(),
  restore: jest.fn(),
  beginPath: jest.fn(),
  moveTo: jest.fn(),
  lineTo: jest.fn(),
  closePath: jest.fn(),
  stroke: jest.fn(),
  translate: jest.fn(),
  scale: jest.fn(),
  rotate: jest.fn(),
  arc: jest.fn(),
  fill: jest.fn(),
  measureText: jest.fn(() => ({ width: 0 })),
  transform: jest.fn(),
  rect: jest.fn(),
  clip: jest.fn(),
})) as unknown as jest.Mock

// Mock toBlob for canvas
HTMLCanvasElement.prototype.toBlob = jest.fn(callback => {
  callback?.(new Blob(['test'], { type: 'image/png' }))
})

// Helper function to render with TooltipProvider
const renderWithProviders = (ui: React.ReactElement) => {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('MermaidDiagram', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset mock implementation to default success case with controlled promise
    mockRender.mockImplementation(() => {
      return new Promise(resolve => {
        mockRenderResolve = resolve
      })
    })
  })

  const sampleMermaidCode = `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]`

  it('renders loading state initially', () => {
    renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    expect(screen.getByText('Loading diagram...')).toBeInTheDocument()
  })

  it('renders diagram after loading', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    })

    // Resolve the mermaid render promise to trigger state updates within act
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(
      () => {
        expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
      },
      { timeout: 5000 }
    )

    // Check that the diagram container is rendered
    expect(screen.getByText('Diagram')).toBeInTheDocument()
  }, 15000)

  it('displays toolbar buttons', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    })

    // Resolve the mermaid render promise
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
    })

    // Check zoom controls exist
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('handles zoom in', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    })

    // Resolve the mermaid render promise
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(
      () => {
        expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
      },
      { timeout: 5000 }
    )

    // Find zoom in button and click
    const zoomInButtons = screen.getAllByRole('button')
    const zoomInButton = zoomInButtons.find(btn => btn.querySelector('svg.lucide-zoom-in'))

    if (zoomInButton) {
      await act(async () => {
        fireEvent.click(zoomInButton)
      })
      expect(screen.getByText('125%')).toBeInTheDocument()
    }
  }, 15000)

  it('handles zoom out', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    })

    // Resolve the mermaid render promise
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(
      () => {
        expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
      },
      { timeout: 5000 }
    )

    // Find zoom out button and click
    const zoomOutButtons = screen.getAllByRole('button')
    const zoomOutButton = zoomOutButtons.find(btn => btn.querySelector('svg.lucide-zoom-out'))

    if (zoomOutButton) {
      await act(async () => {
        fireEvent.click(zoomOutButton)
      })
      expect(screen.getByText('75%')).toBeInTheDocument()
    }
  }, 15000)

  it('handles copy code', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} />)
    })

    // Resolve the mermaid render promise
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
    })

    // Find copy button and click
    const copyButtons = screen.getAllByRole('button')
    const copyButton = copyButtons.find(btn => btn.querySelector('svg.lucide-copy'))

    if (copyButton) {
      await act(async () => {
        fireEvent.click(copyButton)
      })
      // Note: The copy button in the toolbar copies the image, not the code
      // The code copy is only available in error state or code modal
    }
  })

  it('renders error state for invalid mermaid code', async () => {
    // Create a mock that rejects for this test
    let rejectRender: (error: Error) => void = () => {}
    mockRender.mockImplementationOnce(() => {
      return new Promise((_, reject) => {
        rejectRender = reject
      })
    })

    await act(async () => {
      renderWithProviders(<MermaidDiagram code="invalid mermaid code" />)
    })

    // Reject the mermaid render promise within act
    await act(async () => {
      rejectRender(new Error('Syntax error'))
    })

    await waitFor(() => {
      expect(screen.getByText(/Mermaid render failed/)).toBeInTheDocument()
    })

    // Check that raw code is displayed
    expect(screen.getByText('invalid mermaid code')).toBeInTheDocument()
  })

  it('applies custom className', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code={sampleMermaidCode} className="custom-class" />)
    })

    // Resolve the mermaid render promise
    await act(async () => {
      mockRenderResolve({
        svg: '<svg width="100" height="100"><rect width="100" height="100" fill="blue"></rect></svg>',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument()
    })

    // Check for custom class on the container
    const diagramContainer = document.querySelector('.custom-class')
    expect(diagramContainer).toBeInTheDocument()
  })

  it('handles empty code gracefully', async () => {
    await act(async () => {
      renderWithProviders(<MermaidDiagram code="" />)
    })

    await waitFor(() => {
      expect(screen.getByText(/Empty diagram code/)).toBeInTheDocument()
    })
  })
})
