// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilePreviewDialog } from '@/components/common/FilePreview/FilePreviewDialog'

jest.mock('@/components/common/FilePreview/FilePreview', () => ({
  FilePreview: () => <div data-testid="mock-file-preview">Preview content</div>,
}))

jest.mock('@/apis/attachments', () => ({
  downloadAttachment: jest.fn(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'actions.close': 'Close',
        'actions.download': 'Download',
        'actions.exit_fullscreen': 'Exit fullscreen',
        'actions.fullscreen': 'Fullscreen',
        'actions.preview': 'Preview',
        'attachment.html.source_mode': 'Source',
      }

      return translations[key] || key
    },
  }),
}))

describe('FilePreviewDialog', () => {
  const defaultProps = {
    open: true,
    onClose: jest.fn(),
    attachmentId: 1,
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 1024,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('toggles application fullscreen preview from the toolbar', () => {
    render(<FilePreviewDialog {...defaultProps} />)

    const dialog = screen.getByRole('dialog')
    const fullscreenButton = screen.getByTestId('file-preview-fullscreen-button')

    expect(dialog).toHaveClass('max-w-5xl')
    expect(fullscreenButton).toHaveAttribute('aria-label', 'Fullscreen')

    fireEvent.click(fullscreenButton)

    expect(dialog).toHaveClass('max-w-none', 'h-dvh')
    expect(fullscreenButton).toHaveAttribute('aria-label', 'Exit fullscreen')

    fireEvent.click(fullscreenButton)

    expect(dialog).toHaveClass('max-w-5xl')
    expect(fullscreenButton).toHaveAttribute('aria-label', 'Fullscreen')
  })
})
