import type { Attachment } from '@/types/api'
import {
  hasVideoInputAttachment,
  isExternalWebContentAttachment,
} from '@/features/tasks/utils/contextAttachments'

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 1,
    filename: 'content',
    file_size: 0,
    mime_type: '',
    status: 'ready',
    file_extension: '',
    created_at: '2026-06-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('context attachment media detection', () => {
  it('does not treat image-only external web content as video input', () => {
    const imageOnlyExternalContent = attachment({
      source_url: 'https://example.com/post',
      external_media_type: 'image',
      image_count: 18,
      video_count: 0,
    })

    expect(isExternalWebContentAttachment(imageOnlyExternalContent)).toBe(true)
    expect(hasVideoInputAttachment(imageOnlyExternalContent)).toBe(false)
  })

  it('treats external web content with videos as video input', () => {
    expect(
      hasVideoInputAttachment(
        attachment({
          source_url: 'https://example.com/post',
          external_media_type: 'mixed',
          image_count: 3,
          video_count: 1,
        })
      )
    ).toBe(true)
  })

  it('uses video_count instead of stale file extension for external web content', () => {
    expect(
      hasVideoInputAttachment(
        attachment({
          source_url: 'https://example.com/post',
          external_media_type: 'image',
          file_extension: '.mp4',
          image_count: 1,
          video_count: 0,
        })
      )
    ).toBe(false)
  })

  it('keeps normal video attachment detection by mime type and extension', () => {
    expect(hasVideoInputAttachment(attachment({ mime_type: 'video/mp4' }))).toBe(true)
    expect(hasVideoInputAttachment(attachment({ file_extension: '.mp4' }))).toBe(true)
  })

  it('does not treat normal image attachments as video input', () => {
    expect(
      hasVideoInputAttachment(attachment({ mime_type: 'image/png', file_extension: '.png' }))
    ).toBe(false)
  })
})
