// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AttachmentUploadPreview component
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AttachmentUploadPreview from '../AttachmentUploadPreview';
import type { MultiAttachmentUploadState } from '@/types/api';

// Mock attachment APIs
jest.mock('@/apis/attachments', () => ({
  formatFileSize: jest.fn((size: number) => `${(size / 1024).toFixed(1)} KB`),
  getFileIcon: jest.fn((_ext: string) => '📄'),
  isImageExtension: jest.fn((ext: string) => ['.jpg', '.png', '.gif'].includes(ext)),
  getAttachmentPreviewUrl: jest.fn((id: number) => `/api/attachments/${id}/preview`),
}));

// Mock getToken
jest.mock('@/apis/user', () => ({
  getToken: jest.fn(() => 'mock-token'),
}));

describe('AttachmentUploadPreview', () => {
  const mockOnRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('rendering', () => {
    test('renders nothing when state is empty', () => {
      const emptyState: MultiAttachmentUploadState = {
        attachments: [],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      const { container } = render(
        <AttachmentUploadPreview state={emptyState} onRemove={mockOnRemove} />
      );

      expect(container.firstChild).toBeNull();
    });

    test('renders uploading files with progress bars', () => {
      const file1 = new File(['content1'], 'upload1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'upload2.pdf', { type: 'application/pdf' });

      const state: MultiAttachmentUploadState = {
        attachments: [],
        uploadingFiles: new Map([
          ['file-1', { file: file1, progress: 25 }],
          ['file-2', { file: file2, progress: 75 }],
        ]),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      expect(screen.getByText('upload1.txt')).toBeInTheDocument();
      expect(screen.getByText('upload2.pdf')).toBeInTheDocument();

      // Check for progress indicators (loading spinners)
      const spinners = document.querySelectorAll('.animate-spin');
      expect(spinners.length).toBeGreaterThan(0);
    });

    test('renders uploaded attachments', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'document.pdf',
            file_size: 1024 * 100, // 100 KB
            mime_type: 'application/pdf',
            status: 'ready',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: 500,
            error_message: null,
          },
          {
            id: 2,
            filename: 'data.xlsx',
            file_size: 1024 * 200,
            mime_type: 'application/vnd.ms-excel',
            status: 'ready',
            file_extension: '.xlsx',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      expect(screen.getByText('document.pdf')).toBeInTheDocument();
      expect(screen.getByText('data.xlsx')).toBeInTheDocument();
      expect(screen.getByText('100.0 KB')).toBeInTheDocument();
      expect(screen.getByText('200.0 KB')).toBeInTheDocument();
    });

    test('renders error messages', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [],
        uploadingFiles: new Map(),
        errors: new Map([
          ['file-1', 'File size exceeds limit'],
          ['file-2', 'Unsupported file type'],
        ]),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      expect(screen.getByText('File size exceeds limit')).toBeInTheDocument();
      expect(screen.getByText('Unsupported file type')).toBeInTheDocument();
    });
  });

  describe('attachment status display', () => {
    test('shows parsing status with spinner', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'parsing.pdf',
            file_size: 1024,
            mime_type: 'application/pdf',
            status: 'parsing',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      const spinners = document.querySelectorAll('.animate-spin');
      expect(spinners.length).toBeGreaterThan(0);
    });

    test('shows failed status with error styling', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'failed.pdf',
            file_size: 1024,
            mime_type: 'application/pdf',
            status: 'failed',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: 'Parsing failed',
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      const { container } = render(
        <AttachmentUploadPreview state={state} onRemove={mockOnRemove} />
      );

      // Check for error styling classes
      const errorElement = container.querySelector('.bg-red-50, .dark\\:bg-red-900\\/20');
      expect(errorElement).toBeInTheDocument();
    });
  });

  describe('image attachments', () => {
    test('displays image thumbnails for image attachments', async () => {
      // Mock successful image fetch
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['fake-image-data'], { type: 'image/png' }),
      });

      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'photo.png',
            file_size: 1024 * 50,
            mime_type: 'image/png',
            status: 'ready',
            file_extension: '.png',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      // Initially shows loading state
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();

      // Wait for image to load
      await waitFor(
        () => {
          const img = screen.queryByAlt('photo.png');
          expect(img).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    test('shows loading spinner while image loads', () => {
      (global.fetch as jest.Mock).mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(() => {
              resolve({
                ok: true,
                blob: async () => new Blob(['fake-image-data'], { type: 'image/png' }),
              });
            }, 100)
          )
      );

      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'loading.jpg',
            file_size: 1024,
            mime_type: 'image/jpeg',
            status: 'ready',
            file_extension: '.jpg',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      // Should show loading spinner
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });

    test('falls back to file icon on image load error', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Failed to fetch image'));

      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'broken.png',
            file_size: 1024,
            mime_type: 'image/png',
            status: 'ready',
            file_extension: '.png',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      // Wait for error handling
      await waitFor(
        () => {
          // Should show file icon instead of image
          expect(screen.getByText('broken.png')).toBeInTheDocument();
          expect(screen.getByText('📄')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });
  });

  describe('remove functionality', () => {
    test('shows remove button for each attachment', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'test.pdf',
            file_size: 1024,
            mime_type: 'application/pdf',
            status: 'ready',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      const removeButtons = screen.getAllByRole('button');
      expect(removeButtons.length).toBeGreaterThan(0);
    });

    test('calls onRemove when remove button clicked', async () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 123,
            filename: 'removeme.txt',
            file_size: 1024,
            mime_type: 'text/plain',
            status: 'ready',
            file_extension: '.txt',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: 100,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      const removeButton = screen.getByRole('button');
      await userEvent.click(removeButton);

      expect(mockOnRemove).toHaveBeenCalledWith(123);
    });

    test('hides remove button when disabled', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'test.pdf',
            file_size: 1024,
            mime_type: 'application/pdf',
            status: 'ready',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} disabled />);

      const removeButtons = screen.queryAllByRole('button');
      expect(removeButtons).toHaveLength(0);
    });
  });

  describe('layout', () => {
    test('displays attachments in horizontal scrollable layout', () => {
      const state: MultiAttachmentUploadState = {
        attachments: Array.from({ length: 5 }, (_, i) => ({
          id: i + 1,
          filename: `file${i + 1}.txt`,
          file_size: 1024,
          mime_type: 'text/plain',
          status: 'ready' as const,
          file_extension: '.txt',
          created_at: new Date().toISOString(),
          subtask_id: null,
          text_length: 100,
          error_message: null,
        })),
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      const { container } = render(
        <AttachmentUploadPreview state={state} onRemove={mockOnRemove} />
      );

      // Check for horizontal scroll container
      const scrollContainer = container.querySelector('.overflow-x-auto');
      expect(scrollContainer).toBeInTheDocument();
    });

    test('displays text length for text documents', () => {
      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'document.txt',
            file_size: 1024,
            mime_type: 'text/plain',
            status: 'ready',
            file_extension: '.txt',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: 1500,
            error_message: null,
          },
        ],
        uploadingFiles: new Map(),
        errors: new Map(),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      expect(screen.getByText(/1,500.*字符/)).toBeInTheDocument();
    });
  });

  describe('mixed state', () => {
    test('renders uploading files, attachments, and errors together', () => {
      const file = new File(['content'], 'uploading.txt', { type: 'text/plain' });

      const state: MultiAttachmentUploadState = {
        attachments: [
          {
            id: 1,
            filename: 'ready.pdf',
            file_size: 1024,
            mime_type: 'application/pdf',
            status: 'ready',
            file_extension: '.pdf',
            created_at: new Date().toISOString(),
            subtask_id: null,
            text_length: null,
            error_message: null,
          },
        ],
        uploadingFiles: new Map([['file-1', { file, progress: 50 }]]),
        errors: new Map([['file-2', 'Upload failed']]),
      };

      render(<AttachmentUploadPreview state={state} onRemove={mockOnRemove} />);

      // All three types should be rendered
      expect(screen.getByText('uploading.txt')).toBeInTheDocument(); // Uploading
      expect(screen.getByText('ready.pdf')).toBeInTheDocument(); // Attachment
      expect(screen.getByText('Upload failed')).toBeInTheDocument(); // Error
    });
  });
});
