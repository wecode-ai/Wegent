import { describe, expect, test } from 'vitest'
import type { Attachment } from '@/types/api'
import { persistAttachmentReferences } from './attachments'

describe('attachment helpers', () => {
  test('replaces transient object URLs with durable local paths', () => {
    const attachment: Attachment = {
      id: 7,
      filename: 'image.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
      local_preview_url: 'blob:composer-preview',
      local_path: '/tmp/image.png',
    }

    expect(persistAttachmentReferences([attachment])).toEqual([
      { ...attachment, local_preview_url: '/tmp/image.png' },
    ])
    expect(attachment.local_preview_url).toBe('blob:composer-preview')
  })

  test('preserves local filesystem previews', () => {
    const attachment: Attachment = {
      id: -1,
      filename: 'image.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
      local_preview_url: '/tmp/image.png',
    }

    expect(persistAttachmentReferences([attachment])).toEqual([attachment])
  })
})
