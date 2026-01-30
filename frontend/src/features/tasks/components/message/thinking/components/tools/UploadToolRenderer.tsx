// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import AttachmentCard from '@/components/common/AttachmentCard'

/**
 * Upload tool renderer
 * Displays file upload input and shows attachment card with download link
 */
export function UploadToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')

  // Extract input (file_path)
  const inputRaw = tool.toolUse.details?.input
  let filePath: string | null = null
  if (inputRaw && typeof inputRaw === 'object') {
    const filePathValue = (inputRaw as Record<string, unknown>).file_path
    if (typeof filePathValue === 'string') {
      filePath = filePathValue
    }
  }

  // Extract output
  const outputRaw = tool.toolResult?.details?.content || tool.toolResult?.details?.output
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  // Parse output to extract attachment info
  let attachmentId: number | null = null
  let outputDisplay: string | null = null

  if (outputRaw) {
    if (typeof outputRaw === 'string') {
      // Try to parse JSON string
      try {
        const parsed = JSON.parse(outputRaw)
        if (parsed.download_url) {
          const match = parsed.download_url.match(/\/api\/attachments\/(\d+)\/download/)
          if (match) {
            attachmentId = parseInt(match[1], 10)
          }
        }
        outputDisplay = outputRaw
      } catch {
        outputDisplay = outputRaw
      }
    } else if (typeof outputRaw === 'object') {
      const obj = outputRaw as Record<string, unknown>
      if (obj.download_url && typeof obj.download_url === 'string') {
        const match = obj.download_url.match(/\/api\/attachments\/(\d+)\/download/)
        if (match) {
          attachmentId = parseInt(match[1], 10)
        }
      }
      outputDisplay = JSON.stringify(outputRaw, null, 2)
    }
  }

  return (
    <div className="space-y-3">
      {filePath && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">
            {t('thinking.tool_input') || 'Input'}
          </div>
          <pre className="text-xs text-text-tertiary bg-fill-tert p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify({ file_path: filePath }, null, 2)}
          </pre>
        </div>
      )}

      {/* Tool Output */}
      {(attachmentId || outputDisplay) && (
        <div>
          <div
            className={`text-xs font-medium mb-1 ${
              isError ? 'text-yellow-600' : 'text-text-secondary'
            }`}
          >
            {isError ? t('thinking.tool_error') || 'Error' : t('thinking.tool_output') || 'Output'}
          </div>

          {/* Show attachment card if upload succeeded */}
          {attachmentId && !isError && (
            <div className="mb-3">
              <AttachmentCard attachmentId={attachmentId} />
            </div>
          )}

          {/* Show raw JSON output (collapsed if attachment card is shown) */}
          {outputDisplay && (
            <details open={!attachmentId}>
              <summary className="cursor-pointer text-xs text-text-muted hover:text-text-secondary mb-2">
                {attachmentId ? 'View raw response' : 'Response details'}
              </summary>
              <pre
                className={`text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words ${
                  isError
                    ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                    : 'text-text-tertiary bg-fill-tert'
                }`}
              >
                {outputDisplay}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* No output yet (streaming) */}
      {!outputDisplay && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Executing...'}
        </div>
      )}
    </div>
  )
}

export default UploadToolRenderer
