// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, WriteToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, formatFileSize, formatLineCount, extractFileName } from '../utils'

/**
 * Renderer for Write tool
 */
export function WriteToolRenderer(props: ToolRendererProps<WriteToolInput>): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading } = props

  const fileName = metadata?.file_name || extractFileName(input?.file_path) || input?.file_path
  const stats =
    metadata?.line_count && metadata?.file_size
      ? `${formatLineCount(metadata.line_count)} ${t('messages.lines') || 'lines'}, ${formatFileSize(metadata.file_size)}`
      : undefined

  // For Write tool, show the content being written
  const contentToShow = output || input?.content
  const {
    data: truncatedContent,
    isTruncated,
    originalLength,
  } = truncateOutput(typeof contentToShow === 'string' ? contentToShow : undefined)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={fileName} width="120px" />}
        stats={stats}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {truncatedContent ? (
          <>
            <div>
              <div className="mb-1 font-medium text-text-secondary text-xs">
                {t('thinking.sections.content') || 'Content'}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-60 overflow-y-auto rounded-md bg-muted/30 p-2">
                {truncatedContent}
              </pre>
            </div>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
          </>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="80px" />
        ) : (
          <span className="text-text-tertiary text-xs">
            {t('thinking.tool_result') || 'File written'}
          </span>
        )}
      </div>
    ),
  }
}
