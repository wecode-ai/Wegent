import { describe, expect, it } from 'vitest'
import { markdownAttachmentRows } from './attachmentMarkdown'

describe('markdownAttachmentRows', () => {
  it('recognizes provider-native links through the unified attachment marker', () => {
    expect(
      markdownAttachmentRows(
        '[changes.patch](/group/project/uploads/hash/changes.patch)\n' +
          '<!-- wegent-attachment:gitlab-encoded -->'
      )
    ).toEqual([{ id: 'gitlab-encoded', display_name: 'changes.patch', size_bytes: 0 }])
  })

  it('keeps recognizing legacy Wegent attachment links', () => {
    expect(markdownAttachmentRows('[capture.png](wegent://attachments/local-id)')).toEqual([
      { id: 'local-id', display_name: 'capture.png', size_bytes: 0 },
    ])
  })
})
