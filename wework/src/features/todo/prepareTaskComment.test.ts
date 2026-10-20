import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { CloudLoopItemAttachment } from '@/api/deliveries'
import '@/i18n'
import { createTaskCommentPreparer } from './prepareTaskComment'

const image = (id: number): Attachment => ({
  id,
  filename: `evidence-${id}.png`,
  file_size: 24,
  mime_type: 'image/png',
  status: 'ready',
  file_extension: 'png',
  created_at: '2026-10-20T00:00:00Z',
  local_path: `C:\\workspace\\evidence-${id}.png`,
})

const issueImage = (id: string): CloudLoopItemAttachment => ({
  id,
  loop_item_id: 'WEG-1',
  display_name: 'evidence.png',
  content_type: 'image/png',
  size_bytes: 24,
  sha256: '',
  created_by_user_id: 1,
  created_at: '2026-10-20T00:00:00Z',
  markdown_url: `/attachments/${id}`,
  markdown: `![evidence.png](/attachments/${id})`,
})

describe('createTaskCommentPreparer', () => {
  it.each(['rejected', 'invalid'] as const)(
    'reuses successful uploads and retries a %s upload after a partial batch failure',
    async failure => {
      const attachments = [image(-1), image(-2)]
      let secondAttempts = 0
      const upload = vi.fn(async (attachment: Attachment) => {
        if (attachment.id === -1) return { ...attachment, id: 42 }
        if (++secondAttempts === 1) {
          if (failure === 'rejected') throw new Error('Upload unavailable')
          return { ...attachment, id: 0 }
        }
        return { ...attachment, id: 43 }
      })
      const importAttachments = vi.fn(async () => [issueImage('saved')])
      const prepare = createTaskCommentPreparer({
        local: false,
        uploadLocalAttachmentToCloud: upload,
        importAttachments,
        persistFailedText: 'Import unavailable',
      })

      await expect(prepare('See images', attachments)).rejects.toThrow()
      expect(importAttachments).not.toHaveBeenCalled()
      const prepared = await prepare('See images', attachments)

      expect(upload.mock.calls.filter(([attachment]) => attachment.id === -1)).toHaveLength(1)
      expect(upload.mock.calls.filter(([attachment]) => attachment.id === -2)).toHaveLength(2)
      expect(prepared.attachments.map(attachment => attachment.id)).toEqual([42, 43])
      expect(importAttachments).toHaveBeenCalledOnce()
    }
  )

  it('refreshes Issue references on retry while reusing the cloud upload', async () => {
    const attachment = image(-1)
    const upload = vi.fn(async () => ({ ...attachment, id: 42 }))
    const importAttachments = vi
      .fn<(...args: [Attachment[]]) => Promise<CloudLoopItemAttachment[]>>()
      .mockResolvedValueOnce([issueImage('deleted')])
      .mockResolvedValueOnce([issueImage('current')])
    const prepare = createTaskCommentPreparer({
      local: false,
      uploadLocalAttachmentToCloud: upload,
      importAttachments,
      persistFailedText: 'Import unavailable',
    })

    await prepare('See image', [attachment])
    const retry = await prepare('See image', [attachment])

    expect(retry.text).toBe('See image\n\n![evidence.png](/attachments/current)')
    expect(importAttachments).toHaveBeenCalledTimes(2)
    expect(upload).toHaveBeenCalledOnce()
  })

  it('shares an in-flight upload between comments using the same local image', async () => {
    const attachment = image(-1)
    let resolveUpload!: (attachment: Attachment) => void
    const uploading = new Promise<Attachment>(resolve => {
      resolveUpload = resolve
    })
    const upload = vi.fn(() => uploading)
    const prepare = createTaskCommentPreparer({
      local: false,
      uploadLocalAttachmentToCloud: upload,
      importAttachments: vi.fn(async () => [issueImage('saved')]),
      persistFailedText: 'Import unavailable',
    })

    const first = prepare('First', [attachment])
    const second = prepare('Second', [attachment])
    expect(upload).toHaveBeenCalledOnce()
    resolveUpload({ ...attachment, id: 42 })
    const prepared = await Promise.all([first, second])

    expect(prepared.map(comment => comment.attachments[0].id)).toEqual([42, 42])
  })
})
