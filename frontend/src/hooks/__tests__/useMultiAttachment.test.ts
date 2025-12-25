// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useMultiAttachment hook
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { useMultiAttachment } from '../useMultiAttachment';
import * as attachmentApi from '@/apis/attachments';
import { toast } from '@/hooks/use-toast';

// Mock the attachment API
jest.mock('@/apis/attachments', () => ({
  uploadAttachment: jest.fn(),
  deleteAttachment: jest.fn(),
  isSupportedExtension: jest.fn(),
  isValidFileSize: jest.fn(),
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10 MB
  SUPPORTED_EXTENSIONS: ['.pdf', '.txt', '.jpg', '.png'],
}));

// Mock toast
jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}));

describe('useMultiAttachment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    test('initializes with empty state', () => {
      const { result } = renderHook(() => useMultiAttachment());

      expect(result.current.state.attachments).toEqual([]);
      expect(result.current.state.uploadingFiles.size).toBe(0);
      expect(result.current.state.errors.size).toBe(0);
      expect(result.current.isUploading).toBe(false);
      expect(result.current.isReadyToSend).toBe(true);
    });
  });

  describe('handleFileSelect', () => {
    test('handles multiple file uploads in parallel', async () => {
      // Mock successful uploads
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);
      (attachmentApi.uploadAttachment as jest.Mock).mockImplementation(async (file, onProgress) => {
        // Simulate progress
        onProgress(50);
        onProgress(100);
        return {
          id: Math.random(),
          filename: file.name,
          file_size: file.size,
          mime_type: 'text/plain',
          status: 'ready',
          text_length: 100,
        };
      });

      const { result } = renderHook(() => useMultiAttachment());

      const file1 = new File(['content1'], 'file1.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'file2.txt', { type: 'text/plain' });

      // Act: Upload multiple files
      await act(async () => {
        await result.current.handleFileSelect([file1, file2]);
      });

      // Assert: Both files should be uploaded
      expect(attachmentApi.uploadAttachment).toHaveBeenCalledTimes(2);
      expect(result.current.state.attachments).toHaveLength(2);
      expect(result.current.isUploading).toBe(false);
      expect(result.current.isReadyToSend).toBe(true);
    });

    test('tracks per-file progress correctly', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);

      let progressCallback: ((progress: number) => void) | null = null;
      (attachmentApi.uploadAttachment as jest.Mock).mockImplementation(async (file, onProgress) => {
        progressCallback = onProgress;
        // Don't resolve immediately - let test control progress
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              id: 1,
              filename: file.name,
              file_size: file.size,
              mime_type: 'text/plain',
              status: 'ready',
            });
          }, 100);
        });
      });

      const { result } = renderHook(() => useMultiAttachment());
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });

      // Start upload
      act(() => {
        result.current.handleFileSelect(file);
      });

      // Wait for upload to start
      await waitFor(() => {
        expect(result.current.state.uploadingFiles.size).toBe(1);
      });

      // Simulate progress updates
      act(() => {
        if (progressCallback) {
          progressCallback(25);
        }
      });

      await waitFor(() => {
        const fileEntry = Array.from(result.current.state.uploadingFiles.values())[0];
        expect(fileEntry?.progress).toBe(25);
      });

      act(() => {
        if (progressCallback) {
          progressCallback(75);
        }
      });

      await waitFor(() => {
        const fileEntry = Array.from(result.current.state.uploadingFiles.values())[0];
        expect(fileEntry?.progress).toBe(75);
      });

      // Wait for completion
      await waitFor(
        () => {
          expect(result.current.state.uploadingFiles.size).toBe(0);
          expect(result.current.state.attachments).toHaveLength(1);
        },
        { timeout: 200 }
      );
    });

    test('handles per-file errors independently', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);

      // First file succeeds, second fails
      (attachmentApi.uploadAttachment as jest.Mock)
        .mockResolvedValueOnce({
          id: 1,
          filename: 'success.txt',
          file_size: 100,
          mime_type: 'text/plain',
          status: 'ready',
        })
        .mockRejectedValueOnce(new Error('Upload failed'));

      const { result } = renderHook(() => useMultiAttachment());

      const file1 = new File(['content1'], 'success.txt', { type: 'text/plain' });
      const file2 = new File(['content2'], 'failure.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFileSelect([file1, file2]);
      });

      // Assert: First file uploaded, second has error
      expect(result.current.state.attachments).toHaveLength(1);
      expect(result.current.state.attachments[0].filename).toBe('success.txt');
      expect(result.current.state.errors.size).toBe(1);
      expect(result.current.isReadyToSend).toBe(false); // Not ready due to error
    });

    test('prevents duplicate file uploads', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);
      (attachmentApi.uploadAttachment as jest.Mock).mockResolvedValue({
        id: 1,
        filename: 'duplicate.txt',
        file_size: 100,
        mime_type: 'text/plain',
        status: 'ready',
      });

      const { result } = renderHook(() => useMultiAttachment());

      const file1 = new File(['content'], 'duplicate.txt', { type: 'text/plain' });

      // Upload first time
      await act(async () => {
        await result.current.handleFileSelect(file1);
      });

      expect(result.current.state.attachments).toHaveLength(1);

      // Try to upload same filename again
      const file2 = new File(['different content'], 'duplicate.txt', {
        type: 'text/plain',
      });

      await act(async () => {
        await result.current.handleFileSelect(file2);
      });

      // Assert: Toast shown, no duplicate upload
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '文件已存在',
          variant: 'destructive',
        })
      );
      expect(result.current.state.attachments).toHaveLength(1); // Still only one
    });

    test('validates unsupported file types', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(false);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);

      const { result } = renderHook(() => useMultiAttachment());

      const file = new File(['content'], 'test.xyz', { type: 'application/xyz' });

      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      // Assert: Error added, no upload attempted
      expect(result.current.state.errors.size).toBe(1);
      expect(result.current.state.attachments).toHaveLength(0);
      expect(attachmentApi.uploadAttachment).not.toHaveBeenCalled();
    });

    test('validates file size limits', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(false);

      const { result } = renderHook(() => useMultiAttachment());

      const file = new File(['x'.repeat(20 * 1024 * 1024)], 'huge.txt', {
        type: 'text/plain',
      });

      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      // Assert: Error added for file size
      expect(result.current.state.errors.size).toBe(1);
      const errorMessage = Array.from(result.current.state.errors.values())[0];
      expect(errorMessage).toContain('exceeds');
      expect(attachmentApi.uploadAttachment).not.toHaveBeenCalled();
    });

    test('handles failed parsing status', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);
      (attachmentApi.uploadAttachment as jest.Mock).mockResolvedValue({
        id: 1,
        filename: 'failed.pdf',
        file_size: 100,
        mime_type: 'application/pdf',
        status: 'failed',
        error_message: 'PDF parsing failed',
      });
      (attachmentApi.deleteAttachment as jest.Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useMultiAttachment());

      const file = new File(['content'], 'failed.pdf', { type: 'application/pdf' });

      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      // Assert: Error recorded, attachment deleted
      expect(result.current.state.errors.size).toBe(1);
      expect(result.current.state.attachments).toHaveLength(0);
      expect(attachmentApi.deleteAttachment).toHaveBeenCalledWith(1);
    });
  });

  describe('handleRemove', () => {
    test('removes attachment from state', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);
      (attachmentApi.uploadAttachment as jest.Mock).mockResolvedValue({
        id: 1,
        filename: 'test.txt',
        file_size: 100,
        mime_type: 'text/plain',
        status: 'ready',
      });
      (attachmentApi.deleteAttachment as jest.Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useMultiAttachment());

      // Upload a file first
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      expect(result.current.state.attachments).toHaveLength(1);

      // Remove it
      await act(async () => {
        await result.current.handleRemove(1);
      });

      // Assert: Removed from state and server
      expect(result.current.state.attachments).toHaveLength(0);
      expect(attachmentApi.deleteAttachment).toHaveBeenCalledWith(1);
    });

    test('does not delete if attachment is linked to subtask', async () => {
      const { result } = renderHook(() => useMultiAttachment());

      // Manually add an attachment linked to a subtask
      act(() => {
        result.current.state.attachments.push({
          id: 1,
          filename: 'linked.txt',
          file_size: 100,
          mime_type: 'text/plain',
          status: 'ready',
          subtask_id: 123, // Linked to subtask
          file_extension: '.txt',
          created_at: new Date().toISOString(),
          text_length: null,
          error_message: null,
        });
      });

      await act(async () => {
        await result.current.handleRemove(1);
      });

      // Assert: Removed from state but not deleted from server
      expect(result.current.state.attachments).toHaveLength(0);
      expect(attachmentApi.deleteAttachment).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    test('resets all state to initial values', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);
      (attachmentApi.uploadAttachment as jest.Mock).mockResolvedValue({
        id: 1,
        filename: 'test.txt',
        file_size: 100,
        mime_type: 'text/plain',
        status: 'ready',
      });

      const { result } = renderHook(() => useMultiAttachment());

      // Upload a file
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      expect(result.current.state.attachments).toHaveLength(1);

      // Reset
      act(() => {
        result.current.reset();
      });

      // Assert: Everything cleared
      expect(result.current.state.attachments).toEqual([]);
      expect(result.current.state.uploadingFiles.size).toBe(0);
      expect(result.current.state.errors.size).toBe(0);
    });
  });

  describe('computed properties', () => {
    test('isUploading returns true when files are uploading', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(true);
      (attachmentApi.isValidFileSize as jest.Mock).mockReturnValue(true);

      let resolveUpload:
        | ((value: {
            id: number;
            filename: string;
            file_size: number;
            mime_type: string;
            status: string;
          }) => void)
        | null = null;
      (attachmentApi.uploadAttachment as jest.Mock).mockImplementation(
        () =>
          new Promise(resolve => {
            resolveUpload = resolve;
          })
      );

      const { result } = renderHook(() => useMultiAttachment());

      const file = new File(['content'], 'test.txt', { type: 'text/plain' });

      act(() => {
        result.current.handleFileSelect(file);
      });

      // Wait for upload to start
      await waitFor(() => {
        expect(result.current.isUploading).toBe(true);
      });

      // Complete the upload
      act(() => {
        if (resolveUpload) {
          resolveUpload({
            id: 1,
            filename: 'test.txt',
            file_size: 100,
            mime_type: 'text/plain',
            status: 'ready',
          });
        }
      });

      await waitFor(() => {
        expect(result.current.isUploading).toBe(false);
      });
    });

    test('isReadyToSend returns false when errors exist', async () => {
      (attachmentApi.isSupportedExtension as jest.Mock).mockReturnValue(false);

      const { result } = renderHook(() => useMultiAttachment());

      const file = new File(['content'], 'invalid.xyz', { type: 'application/xyz' });

      await act(async () => {
        await result.current.handleFileSelect(file);
      });

      expect(result.current.isReadyToSend).toBe(false);
    });

    test('isReadyToSend returns false when attachments are not ready', () => {
      const { result } = renderHook(() => useMultiAttachment());

      // Manually add a parsing attachment
      act(() => {
        result.current.state.attachments.push({
          id: 1,
          filename: 'parsing.txt',
          file_size: 100,
          mime_type: 'text/plain',
          status: 'parsing', // Not ready yet
          subtask_id: null,
          file_extension: '.txt',
          created_at: new Date().toISOString(),
          text_length: null,
          error_message: null,
        });
      });

      expect(result.current.isReadyToSend).toBe(false);
    });
  });
});
