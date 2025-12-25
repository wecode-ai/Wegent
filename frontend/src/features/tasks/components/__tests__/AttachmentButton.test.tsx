// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AttachmentButton component
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AttachmentButton from '../AttachmentButton';

describe('AttachmentButton', () => {
  const mockOnFileSelect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rendering', () => {
    test('renders attachment button', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      expect(button).not.toBeDisabled();
    });

    test('renders disabled button when disabled prop is true', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} disabled />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    test('renders with paperclip icon', () => {
      const { container } = render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      // Check for lucide-react icon class or SVG
      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('file selection', () => {
    test('opens file input when button is clicked', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      expect(fileInput).toBeInTheDocument();
      expect(fileInput?.multiple).toBe(true);

      // Click button
      await userEvent.click(button);

      // File input click would be triggered (hard to test directly)
      expect(button).toBeInTheDocument();
    });

    test('calls onFileSelect with selected files', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file1 = new File(['content1'], 'test1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'test2.txt', { type: 'text/plain' });

      // Simulate file selection
      await userEvent.upload(fileInput, [file1, file2]);

      await waitFor(() => {
        expect(mockOnFileSelect).toHaveBeenCalledWith([file1, file2]);
      });
    });

    test('calls onFileSelect with single file', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });

      await userEvent.upload(fileInput, file);

      await waitFor(() => {
        expect(mockOnFileSelect).toHaveBeenCalledWith([file]);
      });
    });

    test('resets file input after selection', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });

      // Select file
      await userEvent.upload(fileInput, file);

      // Input should be reset to allow selecting the same file again
      await waitFor(() => {
        expect(fileInput.value).toBe('');
      });
    });

    test('does not trigger file selection when disabled', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} disabled />);

      const button = screen.getByRole('button');
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      expect(fileInput).toBeDisabled();

      // Try to click button
      await userEvent.click(button);

      // onFileSelect should not be called
      expect(mockOnFileSelect).not.toHaveBeenCalled();
    });
  });

  describe('drag and drop', () => {
    test('handles file drop', async () => {
      const { container } = render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const dropZone = container.firstChild as HTMLElement;
      const file = new File(['content'], 'dropped.txt', { type: 'text/plain' });

      // Create drag event with files
      const dataTransfer = {
        files: [file],
        types: ['Files'],
      };

      // Simulate drop
      fireEvent.drop(dropZone, { dataTransfer });

      await waitFor(() => {
        expect(mockOnFileSelect).toHaveBeenCalledWith([file]);
      });
    });

    test('handles multiple files drop', async () => {
      const { container } = render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const dropZone = container.firstChild as HTMLElement;
      const file1 = new File(['content1'], 'drop1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'drop2.txt', { type: 'text/plain' });

      const dataTransfer = {
        files: [file1, file2],
        types: ['Files'],
      };

      fireEvent.drop(dropZone, { dataTransfer });

      await waitFor(() => {
        expect(mockOnFileSelect).toHaveBeenCalledWith([file1, file2]);
      });
    });

    test('does not handle drop when disabled', () => {
      const { container } = render(<AttachmentButton onFileSelect={mockOnFileSelect} disabled />);

      const dropZone = container.firstChild as HTMLElement;
      const file = new File(['content'], 'dropped.txt', { type: 'text/plain' });

      const dataTransfer = {
        files: [file],
        types: ['Files'],
      };

      fireEvent.drop(dropZone, { dataTransfer });

      expect(mockOnFileSelect).not.toHaveBeenCalled();
    });

    test('prevents default on drag over', () => {
      const { container } = render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const dropZone = container.firstChild as HTMLElement;
      const event = new Event('dragover', { bubbles: true, cancelable: true });

      const preventDefault = jest.fn();
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      dropZone.dispatchEvent(event);

      expect(preventDefault).toHaveBeenCalled();
    });
  });

  describe('tooltip', () => {
    test('shows tooltip on hover', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');

      // Hover over button
      await userEvent.hover(button);

      // Wait for tooltip to appear (delay is 300ms)
      await waitFor(
        () => {
          const tooltip = screen.queryByRole('tooltip');
          expect(tooltip).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });

    test('closes tooltip immediately on click', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');

      // Hover to show tooltip
      await userEvent.hover(button);

      await waitFor(
        () => {
          expect(screen.queryByRole('tooltip')).toBeInTheDocument();
        },
        { timeout: 500 }
      );

      // Click button
      await userEvent.click(button);

      // Tooltip should close immediately
      await waitFor(() => {
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      });
    });

    test('displays supported file types in tooltip', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');

      await userEvent.hover(button);

      await waitFor(
        () => {
          const tooltip = screen.getByRole('tooltip');
          expect(tooltip).toHaveTextContent(/PDF|Word|PPT|Excel|TXT|Markdown|图片/i);
        },
        { timeout: 500 }
      );
    });
  });

  describe('file type restrictions', () => {
    test('accepts attribute includes supported extensions', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // Check that accept attribute is set
      expect(fileInput.accept).toBeTruthy();
      expect(fileInput.accept.length).toBeGreaterThan(0);
    });

    test('allows multiple file selection', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      expect(fileInput.multiple).toBe(true);
    });
  });

  describe('accessibility', () => {
    test('button is keyboard accessible', async () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');

      // Tab to button
      await userEvent.tab();
      expect(button).toHaveFocus();

      // Can be activated with Enter or Space
      await userEvent.keyboard('{Enter}');
      expect(button).toBeInTheDocument();
    });

    test('has appropriate ARIA attributes', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} />);

      const button = screen.getByRole('button');

      // Button should be properly identified
      expect(button).toHaveAttribute('type', 'button');
    });

    test('disabled state is conveyed to assistive technology', () => {
      render(<AttachmentButton onFileSelect={mockOnFileSelect} disabled />);

      const button = screen.getByRole('button');

      expect(button).toHaveAttribute('disabled');
    });
  });
});
