// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MermaidDiagram from './MermaidDiagram';

// Mock the theme context
vi.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

// Mock the translation hook
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'mermaid.renderError': 'Mermaid render failed',
        'mermaid.copied': 'Copied',
        'mermaid.copyCode': 'Copy Code',
        'mermaid.zoomIn': 'Zoom In',
        'mermaid.zoomOut': 'Zoom Out',
        'mermaid.resetZoom': 'Reset Zoom',
        'mermaid.exportPng': 'Export PNG',
        'mermaid.exportSuccess': 'Exported',
        'knowledge:diagram': 'Diagram',
      };
      return translations[key] || key;
    },
  }),
}));

// Mock mermaid library
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg><rect width="100" height="100" fill="blue"></rect></svg>',
    }),
  },
}));

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleMermaidCode = `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]`;

  it('renders loading state initially', () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);
    expect(screen.getByText('Loading diagram...')).toBeInTheDocument();
  });

  it('renders diagram after loading', async () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Check that the diagram container is rendered
    expect(screen.getByText('Diagram')).toBeInTheDocument();
  });

  it('displays toolbar buttons', async () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Check zoom controls exist
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('handles zoom in', async () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Find zoom in button and click
    const zoomInButtons = screen.getAllByRole('button');
    const zoomInButton = zoomInButtons.find((btn) =>
      btn.querySelector('svg.lucide-zoom-in')
    );

    if (zoomInButton) {
      fireEvent.click(zoomInButton);
      expect(screen.getByText('125%')).toBeInTheDocument();
    }
  });

  it('handles zoom out', async () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Find zoom out button and click
    const zoomOutButtons = screen.getAllByRole('button');
    const zoomOutButton = zoomOutButtons.find((btn) =>
      btn.querySelector('svg.lucide-zoom-out')
    );

    if (zoomOutButton) {
      fireEvent.click(zoomOutButton);
      expect(screen.getByText('75%')).toBeInTheDocument();
    }
  });

  it('handles copy code', async () => {
    render(<MermaidDiagram code={sampleMermaidCode} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Find copy button and click
    const copyButtons = screen.getAllByRole('button');
    const copyButton = copyButtons.find((btn) =>
      btn.querySelector('svg.lucide-copy')
    );

    if (copyButton) {
      fireEvent.click(copyButton);
      await waitFor(() => {
        expect(mockClipboard.writeText).toHaveBeenCalledWith(sampleMermaidCode);
      });
    }
  });

  it('renders error state for invalid mermaid code', async () => {
    // Mock mermaid to throw an error
    const mermaid = await import('mermaid');
    vi.mocked(mermaid.default.render).mockRejectedValueOnce(new Error('Syntax error'));

    render(<MermaidDiagram code="invalid mermaid code" />);

    await waitFor(() => {
      expect(screen.getByText(/Mermaid render failed/)).toBeInTheDocument();
    });

    // Check that raw code is displayed
    expect(screen.getByText('invalid mermaid code')).toBeInTheDocument();
  });

  it('applies custom className', async () => {
    const { container } = render(
      <MermaidDiagram code={sampleMermaidCode} className="custom-class" />
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram...')).not.toBeInTheDocument();
    });

    // Check for custom class on the container
    const diagramContainer = container.querySelector('.custom-class');
    expect(diagramContainer).toBeInTheDocument();
  });

  it('handles empty code gracefully', async () => {
    // Mock mermaid to throw an error for empty code
    const mermaid = await import('mermaid');
    vi.mocked(mermaid.default.render).mockRejectedValueOnce(new Error('Empty diagram code'));

    render(<MermaidDiagram code="" />);

    await waitFor(() => {
      expect(screen.getByText(/Empty diagram code/)).toBeInTheDocument();
    });
  });
});
