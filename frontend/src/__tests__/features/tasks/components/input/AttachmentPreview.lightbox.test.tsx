import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'

import AttachmentPreview from '@/features/tasks/components/input/AttachmentPreview'
import type { Attachment } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/useAttachmentImage', () => ({
  useAttachmentImage: () => ({
    blobUrl: 'blob:preview-image',
    isLoading: false,
    error: false,
  }),
}))

jest.mock('@/apis/attachments', () => ({
  formatFileSize: () => '12 KB',
  getFileIcon: () => 'file',
  downloadAttachment: jest.fn(),
  isImageExtension: (extension: string) =>
    ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(extension),
  isHtmlExtension: () => false,
}))

jest.mock('@/components/common/FilePreview', () => ({
  FilePreviewDialog: () => null,
}))

const imageAttachment: Attachment = {
  id: 1049,
  filename: 'screenshot.png',
  file_size: 12_345,
  mime_type: 'image/png',
  status: 'ready',
  text_length: null,
  error_message: null,
  error_code: null,
  subtask_id: 88,
  file_extension: '.png',
  created_at: '2026-06-18T00:00:00Z',
}

describe('AttachmentPreview lightbox', () => {
  it('opens image previews above the floating chat input layer', () => {
    render(
      <div data-testid="floating-input-layer" className="fixed bottom-0 z-50">
        <AttachmentPreview attachment={imageAttachment} />
      </div>
    )

    fireEvent.click(screen.getByAltText('screenshot.png'))

    const dialog = screen.getByRole('dialog', { name: 'screenshot.png' })

    expect(dialog).toHaveClass('fixed', 'inset-0', 'z-[9999]')
    expect(dialog.parentElement).toBe(document.body)
    expect(within(dialog).getByAltText('screenshot.png')).toHaveAttribute(
      'src',
      'blob:preview-image'
    )
  })
})
