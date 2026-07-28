// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createDocumentsFromAttachments } from '@/features/knowledge/document/utils/document-creation'
import type { Attachment } from '@/types/api'
import type { KnowledgeDocument } from '@/types/knowledge'

const attachment = (id: number, filename: string): Attachment => ({
  id,
  filename,
  file_size: 4,
  mime_type: 'text/plain',
  status: 'ready',
  file_extension: '.txt',
  created_at: '2026-07-28T00:00:00Z',
})

describe('createDocumentsFromAttachments', () => {
  it('returns one result per attachment and continues after a failure', async () => {
    const createDocument = jest
      .fn()
      .mockRejectedValueOnce(new Error('duplicate'))
      .mockResolvedValueOnce({ id: 202 } as KnowledgeDocument)

    const results = await createDocumentsFromAttachments({
      attachments: [
        {
          attachment: attachment(101, 'failed.txt'),
          file: new File(['fail'], 'failed.txt', { type: 'text/plain' }),
        },
        {
          attachment: attachment(102, 'created.txt'),
          file: new File(['done'], 'created.txt', { type: 'text/plain' }),
        },
      ],
      folderId: 7,
      createDocument,
      fallbackError: 'create failed',
    })

    expect(results).toEqual([
      { attachmentId: 101, error: 'duplicate' },
      { attachmentId: 102, documentId: 202 },
    ])
    expect(createDocument).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attachment_id: 102,
        name: 'created.txt',
        file_extension: 'txt',
        folder_id: 7,
      })
    )
  })
})
