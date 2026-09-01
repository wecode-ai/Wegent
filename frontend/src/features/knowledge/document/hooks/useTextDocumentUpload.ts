// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react'
import { uploadAttachment, deleteAttachment, getErrorMessageFromCode } from '@/apis/attachments'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment } from '@/types/api'

/** Keep a successfully uploaded text attachment when document creation needs a retry. */
export function useTextDocumentUpload() {
  const { t } = useTranslation('common')
  const cached = useRef<{
    content: string
    title: string
    file: File
    attachment: Attachment
  } | null>(null)

  const upload = async (content: string, title: string) => {
    if (cached.current?.content === content && cached.current.title === title) {
      return { file: cached.current.file, attachment: cached.current.attachment }
    }

    const name = title.trim() || `document_${Date.now()}`
    const file = new File([content], name.endsWith('.txt') ? name : `${name}.txt`, {
      type: 'text/plain',
    })
    const response = await uploadAttachment(file)
    if (response.status === 'failed') {
      try {
        await deleteAttachment(response.id)
      } catch {
        // Cleanup must not replace the original parsing error.
      }
      throw new Error(
        getErrorMessageFromCode(response.error_code, t) ||
          response.error_message ||
          t('attachment.errors.parse_failed')
      )
    }

    const attachment: Attachment = {
      ...response,
      file_extension: '.txt',
      created_at: new Date().toISOString(),
    }
    cached.current = { content, title, file, attachment }
    return { file, attachment }
  }

  return {
    upload,
    reset: () => {
      cached.current = null
    },
  }
}
