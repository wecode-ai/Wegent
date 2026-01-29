// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachments API
 */

import { uploadFile, apiRequest } from './client'
import type { AttachmentResponse } from './types'

/**
 * Upload web content as a text attachment
 */
export async function uploadTextContent(
  content: string,
  filename: string,
): Promise<AttachmentResponse> {
  // Create a text file blob
  const blob = new Blob([content], { type: 'text/plain' })

  const response = await uploadFile('/attachments/upload', blob, filename)
  return response.json()
}

/**
 * Upload a file as attachment
 */
export async function uploadFileAttachment(
  file: File,
): Promise<AttachmentResponse> {
  const response = await uploadFile('/attachments/upload', file, file.name)
  return response.json()
}

/**
 * Get attachment by ID
 */
export async function getAttachment(attachmentId: number): Promise<AttachmentResponse> {
  return apiRequest<AttachmentResponse>(`/attachments/${attachmentId}`)
}

/**
 * Delete attachment by ID
 */
export async function deleteAttachment(attachmentId: number): Promise<void> {
  await apiRequest<void>(`/attachments/${attachmentId}`, {
    method: 'DELETE',
  })
}
